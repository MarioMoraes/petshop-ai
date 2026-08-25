import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  DEFAULT_BILLING_SETTINGS,
  type BillingSettings,
  type PaymentMethod,
  type UpdateBillingSettingsInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { methodNotEnabled } from '../../lib/errors.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet, invalidateSettings } from '../../lib/redis.js'
import type { ActorContext } from './actor.js'
import { tenantOptions } from './actor.js'

/**
 * `billing_settings` — as políticas financeiras do tenant.
 *
 * A linha é criada preguiçosamente, como a conta: um tenant que nunca abriu a tela de
 * configuração opera com os padrões, e forçar a criação no provisionamento só
 * adiantaria trabalho para quem talvez nunca use o módulo.
 *
 * `no_show_fee_percent` e `cancellation_window_hours` **não** moram aqui. Vivem em
 * `tenant_settings` desde o MOD-AGENDA e o scheduling-service já calcula a taxa com
 * eles; duplicá-los criaria duas fontes de verdade sobre quanto se cobra de quem falta.
 */

export async function loadSettings(
  tx: TenantTransaction,
  tenantId: string,
): Promise<BillingSettings> {
  const row = await tx.billingSettings.findFirst({ where: { tenantId } })
  if (!row) return DEFAULT_BILLING_SETTINGS

  return {
    creditLimitCents: row.creditLimitCents === null ? null : Number(row.creditLimitCents),
    overdueDays: row.overdueDays,
    // Coluna vazia é tenant que nunca configurou: cair no padrão é mais útil que
    // recusar todo pagamento por "nenhuma forma habilitada".
    enabledPaymentMethods:
      row.enabledPaymentMethods.length > 0
        ? row.enabledPaymentMethods
        : DEFAULT_BILLING_SETTINGS.enabledPaymentMethods,
    defaultPackageValidityDays: row.defaultPackageValidityDays,
    packageExpiryWarningDays: row.packageExpiryWarningDays,
    noShowConsumesPackageCredit: row.noShowConsumesPackageCredit,
    receiptFooterText: row.receiptFooterText,
  }
}

/** Leitura de tela, com cache de 15 min — a tabela muda algumas vezes por ano. */
export async function getSettings(actor: ActorContext): Promise<BillingSettings> {
  const key = CACHE_KEYS.settings(actor.tenantId)
  const cached = await cacheGet<BillingSettings>(key)
  if (cached) return cached

  const settings = await withTenant(actor.tenantId, (tx) => loadSettings(tx, actor.tenantId))
  await cacheSet(key, settings, CACHE_TTL_SECONDS.settings)
  return settings
}

/**
 * PATCH parcial. Só o que veio no corpo muda.
 *
 * A auditoria grava o antes e o depois porque mudar o limite de crédito ou a validade
 * do pacote é decisão sensível: o §9 lista `ledger.settings_updated` entre as ações
 * que exigem trilha imutável, e "quem baixou o limite na sexta-feira" é pergunta que
 * se faz na segunda.
 */
export async function updateSettings(
  actor: ActorContext,
  input: UpdateBillingSettingsInput,
): Promise<BillingSettings> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await loadSettings(tx, actor.tenantId)

      const data = {
        ...(input.creditLimitCents !== undefined
          ? { creditLimitCents: input.creditLimitCents === null ? null : BigInt(input.creditLimitCents) }
          : {}),
        ...(input.overdueDays !== undefined ? { overdueDays: input.overdueDays } : {}),
        ...(input.enabledPaymentMethods !== undefined
          ? { enabledPaymentMethods: input.enabledPaymentMethods }
          : {}),
        ...(input.defaultPackageValidityDays !== undefined
          ? { defaultPackageValidityDays: input.defaultPackageValidityDays }
          : {}),
        ...(input.packageExpiryWarningDays !== undefined
          ? { packageExpiryWarningDays: input.packageExpiryWarningDays }
          : {}),
        ...(input.noShowConsumesPackageCredit !== undefined
          ? { noShowConsumesPackageCredit: input.noShowConsumesPackageCredit }
          : {}),
        ...(input.receiptFooterText !== undefined
          ? { receiptFooterText: input.receiptFooterText }
          : {}),
      }

      await tx.billingSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          enabledPaymentMethods: DEFAULT_BILLING_SETTINGS.enabledPaymentMethods,
          ...data,
        },
        update: data,
      })

      const after = await loadSettings(tx, actor.tenantId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'ledger.settings_updated',
        entity: 'billing_settings',
        entityId: actor.tenantId,
        before,
        after,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return after
    },
    tenantOptions(actor),
  )

  await invalidateSettings(actor.tenantId)
  return result
}

/**
 * AC-04 de MOD-LEDGER-03: o tenant desligou essa forma de pagamento.
 *
 * A lista existe para o petshop que não tem maquininha não ver a opção no balcão —
 * e para que "recebi no cartão" não seja registrado onde cartão nunca entrou.
 */
export function assertMethodEnabled(settings: BillingSettings, method: PaymentMethod): void {
  if (settings.enabledPaymentMethods.includes(method)) return

  throw methodNotEnabled('Forma de pagamento não habilitada para este estabelecimento', {
    method,
    enabledPaymentMethods: settings.enabledPaymentMethods,
  })
}
