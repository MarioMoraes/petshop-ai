import { hashSearchable, withTenant, type TenantTransaction } from '@petshop/db'
import {
  findTemplateDefinition,
  type EnqueueMessageInput,
  type MessageCategory,
  type MessageChannel,
  type MessageOriginType,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/events.js'
import { logger } from '../../lib/logger.js'
import {
  invalidTransition,
  messagingDisabled,
  notFound,
  unknownTemplate,
} from '../../lib/errors.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher } from './crypto.js'
import { render } from './render.js'
import { resolveDelivery } from './recipient.js'
import { resolveTemplate } from './templates.js'
import { loadSettings } from './settings.js'
import { nextOpening } from './window.js'

/**
 * O enfileiramento — a única porta de entrada do envio (§5 do PRD).
 *
 * Cinco decisões acontecem aqui, nesta ordem, e a ordem importa:
 *
 * 1. **O motor está ligado?** Desligado recusa (RN-13) em vez de acumular.
 * 2. **Já pedi isso?** `dedupeKey` devolve a mensagem existente sem criar outra.
 * 3. **Para onde e por qual canal?** A cascata de `recipient.ts`, que pode bloquear.
 * 4. **Com que texto?** Renderizado **agora** (RN-14), com os dados deste instante.
 * 5. **Quando pode sair?** A janela de silêncio, que agenda em vez de descartar.
 */

export interface EnqueueResult {
  id: string
  status: string
  /** `true` quando o `dedupeKey` já existia — o chamador recebe 200, não 201. */
  duplicate: boolean
}

/**
 * Variáveis que o motor resolve sozinho.
 *
 * Todo chamador precisaria delas e nenhum deveria ter de buscá-las: o nome do petshop
 * e o do tutor são de quem envia e de quem recebe, não do assunto da mensagem.
 */
async function baseVariables(
  tx: TenantTransaction,
  tutorId: string,
): Promise<Record<string, string>> {
  const [tutor, tenant, settings] = await Promise.all([
    tx.tutor.findUnique({ where: { id: tutorId }, select: { fullName: true } }),
    tx.tenant.findFirst({ select: { name: true } }),
    // O telefone público entrou em `tenant_settings` com o perfil do tenant
    // (2026-08-28). Antes dele esta variável renderizava vazio, e toda mensagem saía
    // dizendo "avise pelo " — a frase ficava de pé, mas sem o número que a justifica.
    tx.tenantSettings.findFirst({ select: { publicPhone: true, publicWhatsapp: true } }),
  ])

  const fullName = tutor?.fullName ?? ''
  return {
    'tutor.nome': fullName,
    'tutor.primeiro_nome': fullName.split(/\s+/)[0] ?? '',
    'petshop.nome': tenant?.name ?? '',
    // O WhatsApp na frente do fixo: quem recebe a mensagem por WhatsApp responde por
    // ele, e o template diz "fale com a gente" — não "ligue".
    'petshop.telefone': settings?.publicWhatsapp ?? settings?.publicPhone ?? '',
  }
}

export async function enqueueMessage(
  actor: ActorContext,
  input: EnqueueMessageInput,
): Promise<EnqueueResult> {
  const definition = findTemplateDefinition(input.templateKey)
  if (!definition) {
    throw unknownTemplate(`Não existe um texto chamado "${input.templateKey}"`)
  }
  const category: MessageCategory = definition.category

  // Explícito pela mesma razão do `dispatch.ts`: as duas saídas — já existia, ou
  // acabou de nascer — não têm os mesmos campos, e a união inferida os tornaria todos
  // opcionais.
  type Enqueued =
    | { id: string; status: string; duplicate: true }
    | {
        id: string
        status: string
        duplicate: false
        channel: MessageChannel
        blockReason: string | null
        scheduledFor: Date | null
      }

  const result: Enqueued = await withTenant(
    actor.tenantId,
    async (tx) => {
      const settings = await loadSettings(tx, actor.tenantId)
      if (!settings.enabled) throw messagingDisabled()

      const existing = await tx.message.findUnique({
        where: { tenantId_dedupeKey: { tenantId: actor.tenantId, dedupeKey: input.dedupeKey } },
        select: { id: true, status: true },
      })
      if (existing) return { id: existing.id, status: existing.status, duplicate: true }

      const cipher = await openCipher(tx, actor.tenantId)
      const decision = await resolveDelivery(tx, cipher, {
        tutorId: input.tutorId,
        preference: input.channel === 'AUTO' ? settings.defaultChannel : input.channel,
        category,
      })

      const channel: MessageChannel = decision.ok ? decision.delivery.channel : decision.channel
      const address = decision.ok ? decision.delivery.address : ''

      const template = await resolveTemplate(tx, input.templateKey, channel)
      if (!template) throw unknownTemplate(`Não existe um texto chamado "${input.templateKey}"`)

      const variables = { ...(await baseVariables(tx, input.tutorId)), ...input.variables }
      const body = render(template.body, variables)
      const subject = template.subject ? render(template.subject, variables).text : null

      if (body.missing.length > 0) {
        // Não impede o envio: um template que perdeu uma variável ainda comunica o
        // essencial, e barrar aqui silenciaria o lembrete inteiro por um campo vazio.
        // Mas o log precisa dizer, porque é assim que se descobre um template errado.
        logger.warn(
          { templateKey: input.templateKey, missing: body.missing },
          'template renderizado com variáveis sem valor',
        )
      }

      // A janela é do tutor: mesmo um `scheduledFor` pedido pelo chamador é empurrado
      // para a próxima abertura se cair na madrugada.
      const wanted = input.scheduledFor ?? new Date()
      const opening = nextOpening(wanted, category, {
        quietStartMin: settings.quietStartMin,
        quietEndMin: settings.quietEndMin,
        marketingWeekdaysOnly: settings.marketingWeekdaysOnly,
        timezone: settings.timezone,
      })
      const scheduledFor = opening ?? input.scheduledFor ?? null

      const blocked = !decision.ok
      const created = await tx.message.create({
        data: {
          tenantId: actor.tenantId,
          tutorId: input.tutorId,
          petId: input.petId ?? null,
          channel,
          category,
          templateKey: input.templateKey,
          templateVersion: template.version,
          toEncrypted: cipher.encrypt(address),
          toHash: hashSearchable(`messaging:${channel.toLowerCase()}`, address.toLowerCase()),
          subjectEncrypted: subject ? cipher.encrypt(subject) : null,
          bodyEncrypted: cipher.encrypt(body.text),
          status: blocked ? 'BLOCKED' : scheduledFor ? 'SCHEDULED' : 'QUEUED',
          blockReason: blocked ? decision.reason : null,
          dedupeKey: input.dedupeKey,
          originType: input.originType ?? null,
          originId: input.originId ?? null,
          scheduledFor: blocked ? null : scheduledFor,
          requestedBy: actor.actorUserId ?? null,
        },
        select: { id: true, status: true },
      })

      return {
        id: created.id,
        status: created.status,
        duplicate: false,
        channel,
        blockReason: blocked ? decision.reason : null,
        scheduledFor: blocked ? null : scheduledFor,
      }
    },
    tenantOptions(actor),
  )

  // Publicação **pós-commit**, como todo evento deste sistema: a mensagem já está no
  // banco, e uma falha de broker não pode desfazê-la.
  if (!result.duplicate) {
    if (result.blockReason) {
      await publishEvent('mensagem.bloqueada', {
        tenantId: actor.tenantId,
        messageId: result.id,
        tutorId: input.tutorId,
        channel: result.channel,
        category,
        blockReason: result.blockReason,
      })
    } else {
      await publishEvent('mensagem.enfileirada', {
        tenantId: actor.tenantId,
        messageId: result.id,
        tutorId: input.tutorId,
        channel: result.channel,
        category,
        templateKey: input.templateKey,
        scheduledFor: result.scheduledFor?.toISOString() ?? null,
      })
    }
  }

  return { id: result.id, status: result.status, duplicate: result.duplicate }
}

/**
 * Cancela o que ainda não saiu, pelo que a originou (AC-06 de MOD-CRM-03).
 *
 * É o que impede o lembrete de amanhã de sair depois do agendamento cancelado hoje às
 * 20h. Devolve quantas foram canceladas, para o chamador logar.
 */
export async function cancelByOrigin(
  tenantId: string,
  originType: MessageOriginType,
  originId: string,
): Promise<number> {
  const { count } = await withTenant(tenantId, (tx) =>
    tx.message.updateMany({
      where: { originType, originId, status: { in: ['QUEUED', 'SCHEDULED'] } },
      data: { status: 'CANCELLED' },
    }),
  )
  return count
}

export async function cancelMessage(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const message = await tx.message.findUnique({ where: { id }, select: { status: true } })
      if (!message) throw notFound()
      if (message.status !== 'QUEUED' && message.status !== 'SCHEDULED') {
        throw invalidTransition(
          `Esta mensagem está em ${message.status} e não pode mais ser cancelada`,
        )
      }
      await tx.message.update({ where: { id }, data: { status: 'CANCELLED' } })
    },
    tenantOptions(actor),
  )
}

/**
 * Reenvio manual de uma mensagem morta (AC-02 de MOD-CRM-11).
 *
 * Volta para `QUEUED` com o contador zerado — e o motor **revalida consentimento e
 * supressão no despacho** (RN-03). Reenvio não é atalho para furar bloqueio: quem
 * pediu para não receber continua não recebendo, e a mensagem vira `BLOCKED` de novo.
 */
export async function retryMessage(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const message = await tx.message.findUnique({ where: { id }, select: { status: true } })
      if (!message) throw notFound()
      if (message.status !== 'DEAD' && message.status !== 'FAILED') {
        throw invalidTransition(
          `Só mensagens com falha podem ser reenviadas (esta está em ${message.status})`,
        )
      }

      await tx.message.update({
        where: { id },
        data: {
          status: 'QUEUED',
          attempts: 0,
          scheduledFor: null,
          errorCode: null,
          errorDetail: null,
          failedAt: null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'message.retried',
        entity: 'messages',
        entityId: id,
        before: { status: message.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )
}
