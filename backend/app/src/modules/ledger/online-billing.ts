import { createHash, randomBytes } from 'node:crypto'
import {
  decryptPlatform,
  decryptWithKey,
  encryptWithKey,
  getTenantKey,
  withTenant,
  type TenantTransaction,
} from '@petshop/db'
import type { AsaasEnvironment, OnlineBilling, SetOnlineBillingInput } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { AsaasHttpError } from '../../shared/asaas-http.js'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { invalidateLedgerSettings } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { billingProviderFailed, invalid } from './errors.js'
import { getTutorBillingPort } from './tutor-billing-port.js'

/**
 * A conexão com a conta do Asaas do estabelecimento (Configurações › Integrações).
 *
 * **Conectar é três coisas numa**: conferir a chave no ambiente escolhido, cadastrar na
 * conta do petshop o webhook que dá baixa nas cobranças, e só então gravar. Um webhook
 * que não foi cadastrado é uma cobrança que o tutor paga e o livro nunca vê — e por isso
 * a falha no cadastro do webhook desfaz a conexão, em vez de gravá-la "pela metade".
 *
 * A chave é cifrada com a DEK do tenant; do token do webhook guarda-se só o hash, e é por
 * ele que a chegada de um evento acha o petshop (`tutor-webhook.ts`).
 */

export const TUTOR_WEBHOOK_PATH = '/internal/v1/asaas/tutor-webhook'

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function webhookUrl(): string {
  const env = loadEnv()
  return env.ASAAS_TUTOR_WEBHOOK_URL ?? `https://${env.APP_DOMAIN}${TUTOR_WEBHOOK_PATH}`
}

export interface OnlineBillingCredentials {
  apiKey: string
  environment: AsaasEnvironment
}

/** A chave decifrada, para quem vai cobrar. `null` sem conexão, ou com a chave recusada. */
export async function loadCredentials(
  tx: TenantTransaction,
  tenantId: string,
): Promise<OnlineBillingCredentials | null> {
  const row = await tx.billingSettings.findUnique({
    where: { tenantId },
    select: { asaasApiKeyEncrypted: true, asaasEnvironment: true, asaasError: true },
  })
  if (!row?.asaasApiKeyEncrypted || !row.asaasEnvironment || row.asaasError) return null
  const key = await getTenantKey(tx, tenantId)
  return {
    apiKey: decryptWithKey(row.asaasApiKeyEncrypted, key),
    environment: row.asaasEnvironment,
  }
}

export async function getOnlineBilling(tenantId: string): Promise<OnlineBilling> {
  const row = await withTenant(tenantId, (tx) =>
    tx.billingSettings.findUnique({
      where: { tenantId },
      select: {
        asaasApiKeyLast4: true,
        asaasEnvironment: true,
        asaasVerifiedAt: true,
        asaasError: true,
      },
    }),
  )
  if (!row?.asaasApiKeyLast4 || !row.asaasEnvironment || !row.asaasVerifiedAt) return null
  return {
    environment: row.asaasEnvironment,
    last4: row.asaasApiKeyLast4,
    verifiedAt: row.asaasVerifiedAt.toISOString(),
    error: row.asaasError,
  }
}

export async function connectOnlineBilling(
  actor: ActorContext,
  input: SetOnlineBillingInput,
): Promise<OnlineBilling> {
  const port = getTutorBillingPort()
  const tenantId = actor.tenantId

  let accepted: boolean
  try {
    accepted = await port.validate(input.apiKey, input.environment)
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'Asaas não respondeu ao conferir a chave')
    throw billingProviderFailed()
  }
  if (!accepted) {
    throw invalid(
      'O Asaas recusou esta chave. Confira se ela é do ambiente escolhido — a chave de teste só vale no sandbox.',
      [{ field: 'apiKey', message: 'Chave recusada pelo Asaas' }],
    )
  }

  const [previous, adminEmail] = await Promise.all([
    withTenant(tenantId, async (tx) => {
      const row = await tx.billingSettings.findUnique({
        where: { tenantId },
        select: { asaasWebhookId: true, asaasApiKeyLast4: true },
      })
      const credentials = row?.asaasWebhookId
        ? await loadCredentialsIgnoringError(tx, tenantId)
        : null
      return row ? { ...row, credentials } : null
    }),
    actor.actorUserId ? emailOf(tenantId, actor.actorUserId) : Promise.resolve(null),
  ])

  const token = randomBytes(32).toString('base64url')
  let webhookId: string
  try {
    ;({ webhookId } = await port.registerWebhook(input.apiKey, input.environment, {
      url: webhookUrl(),
      authToken: token,
      // Para onde o Asaas avisa quando a fila do webhook trava. É o e-mail de quem
      // conectou, que é quem consegue destravar no painel dele.
      email: adminEmail,
    }))
  } catch (error) {
    logger.warn(
      { err: error, tenantId, status: error instanceof AsaasHttpError ? error.status : undefined },
      'Asaas recusou o cadastro do webhook',
    )
    throw billingProviderFailed(
      'O Asaas aceitou a chave, mas não o cadastro da baixa automática. Tente de novo em instantes.',
    )
  }

  const last4 = input.apiKey.slice(-4)

  await withTenant(
    tenantId,
    async (tx) => {
      const key = await getTenantKey(tx, tenantId)
      const fields = {
        asaasApiKeyEncrypted: encryptWithKey(input.apiKey, key),
        asaasApiKeyLast4: last4,
        asaasEnvironment: input.environment,
        asaasWebhookId: webhookId,
        asaasWebhookTokenHash: hashWebhookToken(token),
        asaasVerifiedAt: new Date(),
        asaasError: null,
      }
      await tx.billingSettings.upsert({
        where: { tenantId },
        create: { tenantId, ...fields },
        update: fields,
      })
      await recordAudit(tx, {
        tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.online_billing_connected',
        entity: 'billing_settings',
        entityId: tenantId,
        before: previous?.asaasApiKeyLast4 ? { last4: previous.asaasApiKeyLast4 } : null,
        after: { last4, environment: input.environment },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  // O webhook da conexão anterior sai depois que a nova está gravada: na ordem inversa,
  // uma falha no meio deixaria o petshop sem baixa nenhuma.
  if (previous?.asaasWebhookId && previous.credentials) {
    await port
      .removeWebhook(
        previous.credentials.apiKey,
        previous.credentials.environment,
        previous.asaasWebhookId,
      )
      .catch((error: unknown) => {
        logger.warn({ err: error, tenantId }, 'webhook antigo ficou na conta do Asaas')
      })
  }

  await invalidateLedgerSettings(tenantId)
  return getOnlineBilling(tenantId)
}

/**
 * Desconectar.
 *
 * As cobranças em aberto são **canceladas** do nosso lado: sem webhook, um pagamento que
 * chegasse por elas seria dinheiro na conta do petshop sem baixa no livro — melhor a
 * tela dizer "cancelada" e a recepção registrar à mão o que o tutor mostrar pago.
 */
export async function disconnectOnlineBilling(actor: ActorContext): Promise<OnlineBilling> {
  const tenantId = actor.tenantId

  const previous = await withTenant(
    tenantId,
    async (tx) => {
      const row = await tx.billingSettings.findUnique({
        where: { tenantId },
        select: { asaasWebhookId: true, asaasApiKeyLast4: true },
      })
      if (!row?.asaasApiKeyLast4) return null
      const credentials = await loadCredentialsIgnoringError(tx, tenantId)

      await tx.billingSettings.update({
        where: { tenantId },
        data: {
          asaasApiKeyEncrypted: null,
          asaasApiKeyLast4: null,
          asaasEnvironment: null,
          asaasWebhookId: null,
          asaasWebhookTokenHash: null,
          asaasVerifiedAt: null,
          asaasError: null,
        },
      })
      const cancelled = await tx.tutorCharge.updateMany({
        where: { status: 'PENDING' },
        data: { status: 'CANCELLED' },
      })
      await recordAudit(tx, {
        tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.online_billing_disconnected',
        entity: 'billing_settings',
        entityId: tenantId,
        before: { last4: row.asaasApiKeyLast4 },
        after: { cancelledCharges: cancelled.count },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      return { webhookId: row.asaasWebhookId, credentials }
    },
    tenantOptions(actor),
  )

  if (previous?.webhookId && previous.credentials) {
    await getTutorBillingPort()
      .removeWebhook(
        previous.credentials.apiKey,
        previous.credentials.environment,
        previous.webhookId,
      )
      .catch((error: unknown) => {
        logger.warn({ err: error, tenantId }, 'webhook ficou na conta do Asaas ao desconectar')
      })
  }

  await invalidateLedgerSettings(tenantId)
  return getOnlineBilling(tenantId)
}

/**
 * O Asaas recusou a chave numa cobrança: revogada, ou conta bloqueada.
 *
 * A chave fica, e o botão do Portal some (`onlinePayment` lê o erro). Só reconectar apaga
 * o aviso, porque é reconectar que prova que a chave voltou a servir.
 */
export async function recordRejection(tenantId: string, detail: string): Promise<void> {
  try {
    await withTenant(tenantId, (tx) =>
      tx.billingSettings.updateMany({
        where: { tenantId, asaasApiKeyEncrypted: { not: null } },
        data: { asaasError: detail.slice(0, 300) },
      }),
    )
    await invalidateLedgerSettings(tenantId)
  } catch (error) {
    logger.error({ err: error, tenantId }, 'não foi possível registrar a recusa da chave do Asaas')
  }
}

/** Para desfazer webhook antigo: a chave serve para apagar mesmo que tenha dado erro antes. */
async function loadCredentialsIgnoringError(
  tx: TenantTransaction,
  tenantId: string,
): Promise<OnlineBillingCredentials | null> {
  const row = await tx.billingSettings.findUnique({
    where: { tenantId },
    select: { asaasApiKeyEncrypted: true, asaasEnvironment: true },
  })
  if (!row?.asaasApiKeyEncrypted || !row.asaasEnvironment) return null
  const key = await getTenantKey(tx, tenantId)
  return {
    apiKey: decryptWithKey(row.asaasApiKeyEncrypted, key),
    environment: row.asaasEnvironment,
  }
}

/** O e-mail de quem conectou, para o Asaas avisar quando a fila do webhook travar. */
async function emailOf(tenantId: string, userId: string): Promise<string | null> {
  try {
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { emailEncrypted: true } }),
    )
    return user ? decryptPlatform(user.emailEncrypted) || null : null
  } catch {
    return null
  }
}
