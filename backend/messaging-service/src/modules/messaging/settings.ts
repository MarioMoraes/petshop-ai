import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  MESSAGING_SETTINGS_DEFAULTS,
  type MessageChannelPref,
  type UpdateMessagingSettingsInput,
} from '@petshop/shared-types'
import {
  CACHE_KEYS,
  CACHE_TTL_SECONDS,
  cacheGet,
  cacheSet,
  invalidateSettings,
} from '../../lib/redis.js'
import { recordAudit } from '../../lib/audit.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * A configuração do motor (MOD-CRM-03, §4 do PRD).
 *
 * Como `taxi_settings` e `billing_settings`, a linha só existe quando o petshop mexe:
 * sem linha, valem os padrões. E `enabled` nasce **false** — ligar o motor é decisão
 * de quem responde pelo domínio de e-mail e pelo número do estabelecimento, não um
 * padrão que o cliente descobre recebendo mensagem.
 */

export interface ResolvedSettings {
  enabled: boolean
  quietStartMin: number
  quietEndMin: number
  marketingWeekdaysOnly: boolean
  dailyCap: number
  perMinuteCap: number
  defaultChannel: MessageChannelPref
  retentionMonths: number
  senderName: string | null
  replyToEmail: string | null
  /** Do `tenant_settings`, não da configuração de mensagens: o fuso é do petshop. */
  timezone: string
}

function minutesFromTime(value: string): number {
  const [hour, minute] = value.split(':')
  return Number(hour) * 60 + Number(minute)
}

function timeFromMinutes(value: number): string {
  const hour = Math.floor(value / 60)
  return `${String(hour).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

export async function loadSettings(
  tx: TenantTransaction,
  tenantId: string,
): Promise<ResolvedSettings> {
  const [row, tenantSettings] = await Promise.all([
    tx.messagingSettings.findUnique({ where: { tenantId } }),
    tx.tenantSettings.findFirst({ select: { timezone: true } }),
  ])

  const timezone = tenantSettings?.timezone ?? DEFAULT_TIMEZONE

  if (!row) {
    return {
      enabled: MESSAGING_SETTINGS_DEFAULTS.enabled,
      quietStartMin: minutesFromTime(MESSAGING_SETTINGS_DEFAULTS.quietStart),
      quietEndMin: minutesFromTime(MESSAGING_SETTINGS_DEFAULTS.quietEnd),
      marketingWeekdaysOnly: MESSAGING_SETTINGS_DEFAULTS.marketingWeekdaysOnly,
      dailyCap: MESSAGING_SETTINGS_DEFAULTS.dailyCap,
      perMinuteCap: MESSAGING_SETTINGS_DEFAULTS.perMinuteCap,
      defaultChannel: MESSAGING_SETTINGS_DEFAULTS.defaultChannel,
      retentionMonths: MESSAGING_SETTINGS_DEFAULTS.retentionMonths,
      senderName: null,
      replyToEmail: null,
      timezone,
    }
  }

  return {
    enabled: row.enabled,
    quietStartMin: row.quietStartMin,
    quietEndMin: row.quietEndMin,
    marketingWeekdaysOnly: row.marketingWeekdaysOnly,
    dailyCap: row.dailyCap,
    perMinuteCap: row.perMinuteCap,
    defaultChannel: row.defaultChannel as MessageChannelPref,
    retentionMonths: row.retentionMonths,
    senderName: row.senderName,
    replyToEmail: row.replyToEmail,
    timezone,
  }
}

/** Leitura com cache, para o caminho quente do worker. */
export async function getSettings(tenantId: string): Promise<ResolvedSettings> {
  const cached = await cacheGet<ResolvedSettings>(CACHE_KEYS.settings(tenantId))
  if (cached) return cached

  const settings = await withTenant(tenantId, (tx) => loadSettings(tx, tenantId))
  await cacheSet(CACHE_KEYS.settings(tenantId), settings, CACHE_TTL_SECONDS.settings)
  return settings
}

export function toApi(settings: ResolvedSettings) {
  return {
    enabled: settings.enabled,
    quietStart: timeFromMinutes(settings.quietStartMin),
    quietEnd: timeFromMinutes(settings.quietEndMin),
    marketingWeekdaysOnly: settings.marketingWeekdaysOnly,
    dailyCap: settings.dailyCap,
    perMinuteCap: settings.perMinuteCap,
    defaultChannel: settings.defaultChannel,
    retentionMonths: settings.retentionMonths,
    senderName: settings.senderName,
    replyToEmail: settings.replyToEmail,
    timezone: settings.timezone,
  }
}

export async function updateSettings(
  actor: ActorContext,
  input: UpdateMessagingSettingsInput,
): Promise<ResolvedSettings> {
  const tenantId = actor.tenantId
  const data: Record<string, unknown> = {}
  if (input.enabled !== undefined) data.enabled = input.enabled
  if (input.quietStart !== undefined) data.quietStartMin = minutesFromTime(input.quietStart)
  if (input.quietEnd !== undefined) data.quietEndMin = minutesFromTime(input.quietEnd)
  if (input.marketingWeekdaysOnly !== undefined) {
    data.marketingWeekdaysOnly = input.marketingWeekdaysOnly
  }
  if (input.dailyCap !== undefined) data.dailyCap = input.dailyCap
  if (input.perMinuteCap !== undefined) data.perMinuteCap = input.perMinuteCap
  if (input.defaultChannel !== undefined) data.defaultChannel = input.defaultChannel
  if (input.retentionMonths !== undefined) data.retentionMonths = input.retentionMonths
  if (input.senderName !== undefined) data.senderName = input.senderName ?? null
  if (input.replyToEmail !== undefined) data.replyToEmail = input.replyToEmail ?? null

  const settings = await withTenant(
    tenantId,
    async (tx) => {
      const before = await loadSettings(tx, tenantId)

      // O `create` precisa dos padrões porque a linha pode não existir — e um PATCH
      // parcial sobre nada precisa nascer com a janela certa, não com zero.
      await tx.messagingSettings.upsert({
        where: { tenantId },
        update: data,
        create: { tenantId, ...data },
      })

      const after = await loadSettings(tx, tenantId)

      await recordAudit(tx, {
        tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'messaging_settings.updated',
        entity: 'messaging_settings',
        entityId: tenantId,
        before: toApi(before),
        after: toApi(after),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return after
    },
    tenantOptions(actor),
  )

  await invalidateSettings(tenantId)

  return settings
}
