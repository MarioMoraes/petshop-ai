import { decryptWithKey, encryptWithKey, getTenantKey, withTenant } from '@petshop/db'
import type { SetAgentApiKeyInput } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { CACHE_KEYS, cacheDelete } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { invalid } from './errors.js'
import { verifyAnthropicKey } from './model-anthropic.js'

/**
 * A chave da Anthropic do estabelecimento (Configurações › Integrações).
 *
 * **Sem ela o agente não fala** — decisão de produto de 2026-09-27: o consumo do modelo é
 * do petshop, e não da plataforma. A chave mora em `agent_settings`, cifrada com a DEK do
 * tenant como todo segredo por tenant, e a tela só recebe os quatro últimos caracteres.
 *
 * **Gravar exige que a Anthropic a aceite antes.** Uma chave colada pela metade seria
 * descoberta no primeiro cliente que escrevesse, e ele receberia "vou chamar alguém" sem
 * que ninguém na loja soubesse por quê. A trilha registra quem trocou e os quatro últimos
 * caracteres, nunca o valor.
 */

/** A conferência na Anthropic, atrás de um ponto de troca para a suíte rodar sem rede. */
export type KeyVerifier = (apiKey: string) => Promise<boolean>

let verifier: KeyVerifier = verifyAnthropicKey

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setKeyVerifier(next: KeyVerifier | null): void {
  verifier = next ?? verifyAnthropicKey
}

/**
 * A chave decifrada, para a porta do modelo.
 *
 * Lida a cada turno, e de propósito: é uma linha por chave primária diante de uma chamada
 * de modelo de segundos, e um cache em memória aqui seria mais uma cópia do segredo para
 * invalidar quando o petshop trocasse a chave num processo e o turno rodasse no outro.
 * `encrypted` vai junto porque é por ele que a porta reconhece o cliente que já montou.
 */
export async function readTenantApiKey(
  tenantId: string,
): Promise<{ apiKey: string; encrypted: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.agentSettings.findUnique({
      where: { tenantId },
      select: { apiKeyEncrypted: true },
    })
    if (!row?.apiKeyEncrypted) return null
    const key = await getTenantKey(tx, tenantId)
    return { apiKey: decryptWithKey(row.apiKeyEncrypted, key), encrypted: row.apiKeyEncrypted }
  })
}

export async function setApiKey(actor: ActorContext, input: SetAgentApiKeyInput): Promise<void> {
  if (!(await verifier(input.apiKey))) {
    throw invalid(
      'A Anthropic recusou esta chave. Confira se ela está ativa e se a conta tem crédito.',
      [{ field: 'apiKey', message: 'Chave recusada pela Anthropic' }],
    )
  }

  const last4 = input.apiKey.slice(-4)

  await withTenant(
    actor.tenantId,
    async (tx) => {
      const key = await getTenantKey(tx, actor.tenantId)
      const encrypted = encryptWithKey(input.apiKey, key)
      const before = await tx.agentSettings.findUnique({
        where: { tenantId: actor.tenantId },
        select: { apiKeyLast4: true },
      })

      const fields = {
        apiKeyEncrypted: encrypted,
        apiKeyLast4: last4,
        apiKeyVerifiedAt: new Date(),
        apiKeyError: null,
      }
      await tx.agentSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, ...fields },
        update: fields,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'agent.api_key_set',
        entity: 'agent_settings',
        entityId: actor.tenantId,
        before: before?.apiKeyLast4 ? { last4: before.apiKeyLast4 } : null,
        after: { last4 },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.agentSettings(actor.tenantId))
}

export async function removeApiKey(actor: ActorContext): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.agentSettings.findUnique({
        where: { tenantId: actor.tenantId },
        select: { apiKeyLast4: true },
      })
      if (!before?.apiKeyLast4) return

      await tx.agentSettings.update({
        where: { tenantId: actor.tenantId },
        data: {
          apiKeyEncrypted: null,
          apiKeyLast4: null,
          apiKeyVerifiedAt: null,
          apiKeyError: null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'agent.api_key_removed',
        entity: 'agent_settings',
        entityId: actor.tenantId,
        before: { last4: before.apiKeyLast4 },
        after: null,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.agentSettings(actor.tenantId))
}

/**
 * A Anthropic recusou a chave no meio de uma conversa.
 *
 * A chave **fica**: quem a revogou por engano e a reativou no painel não precisa colá-la
 * de novo, e a próxima conversa que der certo não apaga o aviso — só um novo cadastro
 * apaga, porque é ele que prova que a chave voltou a servir. Falha ao gravar o aviso não
 * sobe: quem chama já está mandando a conversa para a recepção.
 */
export async function recordKeyRejection(tenantId: string, detail: string): Promise<void> {
  try {
    await withTenant(tenantId, (tx) =>
      tx.agentSettings.updateMany({
        where: { tenantId, apiKeyEncrypted: { not: null } },
        data: { apiKeyError: detail.slice(0, 300) },
      }),
    )
  } catch (error) {
    logger.error({ err: error, tenantId }, 'não foi possível registrar a recusa da chave')
  }
}
