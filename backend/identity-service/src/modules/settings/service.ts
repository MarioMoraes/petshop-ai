import { withTenant, type TenantSettings as TenantSettingsRow } from '@petshop/db'
import {
  BrandingSchema,
  BusinessHoursSchema,
  DEFAULT_BRANDING,
  IDENTITY_ROUTING_KEYS,
  type Branding,
  type BusinessHours,
  type TenantAddress,
  type TenantSettings,
  type UpdateTenantSettingsInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../lib/redis.js'

/**
 * Configurações do tenant (MOD-IDENT-08, parcial).
 *
 * Entra nesta fase porque a etapa 3 do wizard escreve aqui. `branding` e
 * `businessHours` são JSONB: são validados na leitura, e não só na escrita, para que
 * um JSON gravado por uma versão anterior do schema não vaze cru para a API.
 */

export async function getSettings(tenantId: string): Promise<TenantSettings> {
  const cached = await cacheGet<TenantSettings>(CACHE_KEYS.tenantSettings(tenantId))
  if (cached) return cached

  const row = await withTenant(tenantId, (tx) =>
    tx.tenantSettings.findUnique({ where: { tenantId } }),
  )
  if (!row) throw notFound('Configurações do estabelecimento não encontradas')

  const settings = toSettings(row)
  await cacheSet(CACHE_KEYS.tenantSettings(tenantId), settings, CACHE_TTL_SECONDS.tenantSettings)
  return settings
}

/**
 * `branding.primaryColor` do tenant, resolvido com o padrão do sistema quando ele
 * ainda não tem `TenantSettings` (onboarding em andamento).
 *
 * Existe separado de `getSettings` porque quem chama é `/v1/me` — a primeira
 * requisição de toda sessão (SLO de p95 120ms) e sem `tenant:read_settings` na
 * maioria dos perfis. Reaproveita o mesmo cache de `getSettings` quando já está
 * quente; no frio, um `select` só de `branding` evita validar a grade de horários e o
 * resto das configurações para devolver uma cor.
 */
export async function getPrimaryColor(tenantId: string): Promise<string> {
  const cached = await cacheGet<TenantSettings>(CACHE_KEYS.tenantSettings(tenantId))
  if (cached) return cached.branding.primaryColor

  const row = await withTenant(tenantId, (tx) =>
    tx.tenantSettings.findUnique({ where: { tenantId }, select: { branding: true } }),
  )
  if (!row) return DEFAULT_BRANDING.primaryColor
  return parseBranding(row.branding).primaryColor
}

export interface UpdateSettingsParams {
  tenantId: string
  actorUserId?: string | undefined
  patch: UpdateTenantSettingsInput
}

export async function updateSettings(params: UpdateSettingsParams): Promise<TenantSettings> {
  const { tenantId, patch } = params
  const changedKeys = Object.keys(patch)
  if (changedKeys.length === 0) return getSettings(tenantId)

  const row = await withTenant(
    tenantId,
    async (tx) => {
      const before = await tx.tenantSettings.findUnique({ where: { tenantId } })
      if (!before) throw notFound('Configurações do estabelecimento não encontradas')

      const updated = await tx.tenantSettings.update({
        where: { tenantId },
        data: {
          ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
          ...(patch.cancellationWindowHours !== undefined
            ? { cancellationWindowHours: patch.cancellationWindowHours }
            : {}),
          ...(patch.noShowFeePercent !== undefined
            ? { noShowFeePercent: patch.noShowFeePercent }
            : {}),
          ...(patch.minBookingNoticeHours !== undefined
            ? { minBookingNoticeHours: patch.minBookingNoticeHours }
            : {}),
          ...(patch.allowOverbooking !== undefined
            ? { allowOverbooking: patch.allowOverbooking }
            : {}),
          ...(patch.onlineBookingEnabled !== undefined
            ? { onlineBookingEnabled: patch.onlineBookingEnabled }
            : {}),
          ...(patch.onlineBookingRequiresApproval !== undefined
            ? { onlineBookingRequiresApproval: patch.onlineBookingRequiresApproval }
            : {}),
          ...addressColumns(patch),
          ...(patch.publicPhone !== undefined ? { publicPhone: patch.publicPhone } : {}),
          ...(patch.publicWhatsapp !== undefined ? { publicWhatsapp: patch.publicWhatsapp } : {}),
          ...(patch.branding !== undefined ? { branding: patch.branding } : {}),
          ...(patch.businessHours !== undefined ? { businessHours: patch.businessHours } : {}),
          ...(patch.whatsappProvisioning !== undefined
            ? { whatsappProvisioning: patch.whatsappProvisioning }
            : {}),
        },
      })

      await recordAudit(tx, {
        tenantId,
        actorUserId: params.actorUserId ?? null,
        action: 'tenant.settings_updated',
        entity: 'tenant_settings',
        entityId: tenantId,
        before: pickChanged(toSettings(before), changedKeys),
        after: pickChanged(toSettings(updated), changedKeys),
      })

      return updated
    },
    params.actorUserId ? { userId: params.actorUserId } : {},
  )

  await cacheDelete(CACHE_KEYS.tenantSettings(tenantId))
  await publishEvent(IDENTITY_ROUTING_KEYS.tenantConfiguracaoAtualizada, {
    tenantId,
    changedKeys,
  })

  // AC-03 de MOD-IDENT-08: agendamentos já criados guardam a política vigente na
  // criação (`appointments.cancellation_policy_snapshot`), então a mudança daqui só
  // vale para os próximos. O snapshot é responsabilidade de MOD-AGENDA, que consome
  // este evento — nada a fazer retroativamente aqui.

  return toSettings(row)
}

function pickChanged(settings: TenantSettings, keys: string[]): Record<string, unknown> {
  const source = settings as unknown as Record<string, unknown>
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

export function toSettings(row: TenantSettingsRow): TenantSettings {
  return {
    timezone: row.timezone,
    cancellationWindowHours: row.cancellationWindowHours,
    noShowFeePercent: row.noShowFeePercent,
    minBookingNoticeHours: row.minBookingNoticeHours,
    allowOverbooking: row.allowOverbooking,
    onlineBookingEnabled: row.onlineBookingEnabled,
    onlineBookingRequiresApproval: row.onlineBookingRequiresApproval,
    branding: parseBranding(row.branding),
    businessHours: parseBusinessHours(row.businessHours),
    whatsappProvisioning: row.whatsappProvisioning,
    address: toAddress(row),
    publicPhone: row.publicPhone,
    publicWhatsapp: row.publicWhatsapp,
  }
}

/**
 * As seis colunas obrigatórias do endereço viram um objeto, ou `null`.
 *
 * `address_zip` é o suficiente para decidir: o CHECK
 * `tenant_settings_address_complete` garante no banco que as seis andam juntas, então
 * não existe o estado de "tem CEP e não tem cidade" a tratar aqui.
 */
function toAddress(row: TenantSettingsRow): TenantAddress | null {
  if (!row.addressZip) return null
  return {
    zipCode: row.addressZip,
    street: row.addressStreet ?? '',
    number: row.addressNumber ?? '',
    complement: row.addressComplement,
    district: row.addressDistrict ?? '',
    city: row.addressCity ?? '',
    state: row.addressState ?? '',
  }
}

/**
 * O caminho inverso. Três casos, e a diferença entre eles importa:
 * `undefined` não mexe no endereço, `null` **apaga** as seis colunas, e um objeto
 * grava as seis. Tratar `null` como "não mexer" deixaria o admin sem como remover um
 * endereço errado depois de publicado.
 */
function addressColumns(patch: UpdateTenantSettingsInput): Record<string, string | null> {
  if (patch.address === undefined) return {}
  if (patch.address === null) {
    return {
      addressZip: null,
      addressStreet: null,
      addressNumber: null,
      addressComplement: null,
      addressDistrict: null,
      addressCity: null,
      addressState: null,
    }
  }
  const address = patch.address
  return {
    addressZip: address.zipCode,
    addressStreet: address.street,
    addressNumber: address.number,
    addressComplement: address.complement ?? null,
    addressDistrict: address.district,
    addressCity: address.city,
    addressState: address.state,
  }
}

function parseBranding(value: unknown): Branding {
  const parsed = BrandingSchema.safeParse(value)
  return parsed.success ? parsed.data : { primaryColor: '#E34A32' }
}

function parseBusinessHours(value: unknown): BusinessHours {
  const parsed = BusinessHoursSchema.safeParse(value)
  if (parsed.success) return parsed.data
  // JSONB gravado por um schema antigo: devolve a grade padrão em vez de estourar
  // a leitura inteira das configurações.
  return {
    monday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
    tuesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
    wednesday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
    thursday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
    friday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
    saturday: { closed: false, opensAt: '08:00', closesAt: '13:00' },
    sunday: { closed: true, opensAt: '08:00', closesAt: '13:00' },
  }
}
