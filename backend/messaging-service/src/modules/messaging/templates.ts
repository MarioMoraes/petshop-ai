import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  EDITABLE_MESSAGE_TEMPLATES,
  MESSAGE_BODY_LIMITS,
  findTemplateDefinition,
  type MessageCategory,
  type MessageChannel,
  type UpsertMessageTemplateInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { invalid, systemTemplate, unknownTemplate } from '../../lib/errors.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../lib/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { UnknownVariablesError, assertKnownVariables } from './render.js'

/**
 * Os textos (MOD-CRM-02).
 *
 * **Divergência consciente do §4 do PRD**, que previa uma linha por template semeada
 * no provisionamento: aqui o banco guarda só o que o petshop **mudou**, e a listagem é
 * a união dos padrões de `messaging-seed.ts` com os overrides. Três ganhos concretos:
 * os tenants que já existem recebem os textos sem backfill; acrescentar um template
 * novo é editar um arquivo, não escrever migration de dados; e não há como o texto do
 * banco divergir do que o código espera renderizar. O efeito observável do AC-01 — o
 * admin abre a tela e encontra os textos prontos — é o mesmo.
 */

export interface ResolvedTemplate {
  key: string
  channel: MessageChannel
  category: MessageCategory
  subject: string | null
  body: string
  active: boolean
  version: number
  /** `false` quando o petshop reescreveu o texto. */
  isDefault: boolean
  variables: readonly string[]
}

function fromDefinition(key: string, channel: MessageChannel): ResolvedTemplate | null {
  const definition = findTemplateDefinition(key)
  if (!definition) return null
  return {
    key,
    channel,
    category: definition.category,
    subject: channel === 'EMAIL' ? (definition.subject ?? null) : null,
    body: definition.body[channel],
    active: true,
    version: 0,
    isDefault: true,
    variables: definition.variables,
  }
}

/**
 * O texto que vale agora para este tenant.
 *
 * Devolve `null` quando o template não existe nem no catálogo nem no tenant — o
 * chamador decide se isso é 422 (o admin pediu) ou log (um consumidor de evento
 * pediu).
 */
export async function resolveTemplate(
  tx: TenantTransaction,
  key: string,
  channel: MessageChannel,
): Promise<ResolvedTemplate | null> {
  const base = fromDefinition(key, channel)
  const override = await tx.messageTemplate.findFirst({ where: { key, channel } })

  if (!override) return base
  if (!base) return null

  return {
    ...base,
    subject: override.subject ?? base.subject,
    body: override.body,
    active: override.active,
    version: override.version,
    isDefault: false,
  }
}

/** Leitura com cache, para o caminho quente do enfileiramento. */
export async function getTemplate(
  tenantId: string,
  key: string,
  channel: MessageChannel,
): Promise<ResolvedTemplate | null> {
  const cacheKey = CACHE_KEYS.template(tenantId, key, channel)
  const cached = await cacheGet<ResolvedTemplate>(cacheKey)
  if (cached) return cached

  const template = await withTenant(tenantId, (tx) => resolveTemplate(tx, key, channel))
  if (template) await cacheSet(cacheKey, template, CACHE_TTL_SECONDS.template)
  return template
}

export async function listTemplates(tenantId: string): Promise<ResolvedTemplate[]> {
  return withTenant(tenantId, async (tx) => {
    const overrides = await tx.messageTemplate.findMany()
    const byKey = new Map(overrides.map((row) => [`${row.key}:${row.channel}`, row]))

    const resolved: ResolvedTemplate[] = []
    /**
     * A tela do CRM mostra o que o petshop pode editar (MOD-NOTIF-04).
     *
     * Os textos de sistema ficam de fora: o corpo deles carrega o endereço do painel, o
     * número do documento e a estrutura que o molde de marca espera. Oferecê-los para
     * edição é oferecer ao admin a chance de quebrar o próprio e-mail de boas-vindas
     * sem saber — e ninguém pediu para reescrever aquele texto. O do lembrete, sim.
     */
    for (const definition of EDITABLE_MESSAGE_TEMPLATES) {
      for (const channel of ['WHATSAPP', 'EMAIL'] as const) {
        const base = fromDefinition(definition.key, channel)
        if (!base) continue
        const override = byKey.get(`${definition.key}:${channel}`)
        resolved.push(
          override
            ? {
                ...base,
                subject: override.subject ?? base.subject,
                body: override.body,
                active: override.active,
                version: override.version,
                isDefault: false,
              }
            : base,
        )
      }
    }
    return resolved
  })
}

export async function upsertTemplate(
  actor: ActorContext,
  key: string,
  channel: MessageChannel,
  input: UpsertMessageTemplateInput,
): Promise<ResolvedTemplate> {
  const definition = findTemplateDefinition(key)
  if (!definition) {
    throw unknownTemplate(`Não existe um texto chamado "${key}"`, {
      available: EDITABLE_MESSAGE_TEMPLATES.map((template) => template.key),
    })
  }

  /**
   * Texto de sistema não se edita (MOD-NOTIF-04).
   *
   * A listagem já não o oferece, e esta guarda existe porque a rota é endereçável: o
   * `PUT /v1/messaging/templates/tenant_welcome/EMAIL` é uma URL que alguém pode
   * digitar. Sem ela, o petshop poderia apagar o endereço do painel do próprio e-mail
   * de boas-vindas — e descobrir isso quando o próximo funcionário não conseguisse entrar.
   */
  if ((definition.authored ?? 'TENANT') === 'SYSTEM') {
    throw systemTemplate('Este texto é do produto e não pode ser editado')
  }

  if (input.body.length > MESSAGE_BODY_LIMITS[channel]) {
    throw invalid(
      `O texto de ${channel === 'WHATSAPP' ? 'WhatsApp' : 'e-mail'} aceita no máximo ` +
        `${MESSAGE_BODY_LIMITS[channel]} caracteres`,
      [{ field: 'body', message: `Máximo de ${MESSAGE_BODY_LIMITS[channel]} caracteres` }],
    )
  }

  if (channel === 'EMAIL' && !input.subject) {
    throw invalid('E-mail exige assunto', [
      { field: 'subject', message: 'Informe o assunto do e-mail' },
    ])
  }

  try {
    assertKnownVariables(key, input.body, input.subject)
  } catch (error) {
    if (error instanceof UnknownVariablesError) {
      throw invalid(
        `Estas variáveis não existem neste texto: ${error.unknown.join(', ')}`,
        error.unknown.map((name) => ({
          field: 'body',
          message: `"{{${name}}}" não existe aqui. Disponíveis: ${error.allowed.join(', ')}`,
        })),
      )
    }
    throw error
  }

  const saved = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await resolveTemplate(tx, key, channel)

      await tx.messageTemplate.upsert({
        where: { tenantId_key_channel: { tenantId: actor.tenantId, key, channel } },
        update: {
          subject: input.subject ?? null,
          body: input.body,
          active: input.active,
          version: { increment: 1 },
          updatedBy: actor.actorUserId ?? null,
        },
        create: {
          tenantId: actor.tenantId,
          key,
          channel,
          subject: input.subject ?? null,
          body: input.body,
          active: input.active,
          updatedBy: actor.actorUserId ?? null,
        },
      })

      const after = await resolveTemplate(tx, key, channel)

      // O diff guarda o texto **anterior e novo** de propósito, ao contrário de quase
      // tudo o mais neste serviço: o corpo do template é escrito pelo petshop e não
      // contém dado de cliente nenhum — só as marcações. É a versão anterior que
      // responde "quem trocou o texto que saiu errado para 300 pessoas".
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'message_template.updated',
        entity: 'message_templates',
        entityId: `${key}:${channel}`,
        before: before ? { subject: before.subject, body: before.body, version: before.version } : null,
        after: after ? { subject: after.subject, body: after.body, version: after.version } : null,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return after
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.template(actor.tenantId, key, channel))
  if (!saved) throw unknownTemplate(`Não existe um texto chamado "${key}"`)
  return saved
}

/**
 * Volta ao texto de fábrica: apaga o override.
 *
 * É o que o AC-04 pede sem dizer — o template de sistema não pode ser **excluído**,
 * mas a customização dele sim, e essa é a operação que o petshop quer quando pede
 * "desfazer". Tentar apagar um texto que nunca foi customizado é 409, porque significa
 * que alguém está tentando apagar o de fábrica.
 */
export async function resetTemplate(
  actor: ActorContext,
  key: string,
  channel: MessageChannel,
): Promise<ResolvedTemplate> {
  const reset = await withTenant(
    actor.tenantId,
    async (tx) => {
      const { count } = await tx.messageTemplate.deleteMany({ where: { key, channel } })
      if (count === 0) throw systemTemplate()

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'message_template.reset',
        entity: 'message_templates',
        entityId: `${key}:${channel}`,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return resolveTemplate(tx, key, channel)
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.template(actor.tenantId, key, channel))
  if (!reset) throw unknownTemplate(`Não existe um texto chamado "${key}"`)
  return reset
}
