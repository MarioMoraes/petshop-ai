import { withTenant, type TenantTransaction } from '@petshop/db'
import type { PortalContextResponse, PortalTenantResponse } from '@petshop/shared-types'
import { notFound } from './errors.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../shared/redis.js'

/**
 * MOD-PORTAL-02 — `GET /portal/v1/me`, o contexto inicial.
 *
 * É a rota que prova que a porta abre: se ela responde com o nome certo e o saldo certo,
 * o `tutorId` atravessou o gateway dentro da assinatura, o escopo `_own` foi aplicado e
 * o vínculo existe. Tudo o que as fatias seguintes acrescentam se apoia nisto.
 *
 * `balance_cents` e `pets_count` vêm dos denormalizados de `tutors`, alimentados por
 * evento desde o MOD-TUTOR. O Portal **não** os recalcula: o SLO da tela é de celular em
 * 4G, e somar lançamento por lançamento aqui repetiria o erro que o RN-10 do MOD-TUTOR
 * já proíbe no balcão.
 */

export type PortalContext = PortalContextResponse

export async function readPortalContext(
  tx: TenantTransaction,
  tenantId: string,
  tutorId: string,
): Promise<PortalContext> {
  const tutor = await tx.tutor.findFirst({
    where: { id: tutorId, anonymizedAt: null, deletedAt: null },
    select: {
      id: true,
      fullName: true,
      socialName: true,
      balanceCents: true,
      petsCount: true,
    },
  })
  if (!tutor) throw notFound()

  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, slug: true },
  })

  const settings = await tx.tenantSettings.findUniqueOrThrow({
    where: { tenantId },
    select: {
      timezone: true,
      portalEnabled: true,
      onlineBookingEnabled: true,
      onlineBookingRequiresApproval: true,
    },
  })

  const taxi = await tx.taxiSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  })

  return {
    tutor: {
      id: tutor.id,
      // RN-14 do MOD-TUTOR: o nome social é o nome exibido, sempre que existe.
      name: tutor.socialName ?? tutor.fullName,
      balanceCents: tutor.balanceCents,
      petsCount: tutor.petsCount,
    },
    tenant: { name: tenant.name, slug: tenant.slug, timezone: settings.timezone },
    features: {
      portalEnabled: settings.portalEnabled,
      onlineBookingEnabled: settings.onlineBookingEnabled,
      onlineBookingRequiresApproval: settings.onlineBookingRequiresApproval,
      taxiEnabled: taxi?.enabled ?? false,
    },
  }
}

/**
 * Marca a visita.
 *
 * Fora da transação de leitura e sem `await` no caminho da resposta: é métrica de
 * adoção, e uma gravação a mais não tem por que somar latência à tela que o tutor está
 * esperando.
 */
export async function touchLastSeen(tenantId: string, tutorId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.tutor.update({ where: { id: tutorId }, data: { portalLastSeenAt: new Date() } }),
  )
}

/**
 * A identidade visual do petshop, para a tela de login (rota pública).
 *
 * O que sai daqui é o que já está impresso na fachada: nome, logo e cor. Nada de
 * cliente, nada de operação. O cache é curto e é de **configuração**, não de dado
 * pessoal — a distinção que o RN-16 faz.
 */
export async function readPortalTenant(tenantId: string): Promise<PortalTenantResponse> {
  const cached = await cacheGet<PortalTenantResponse>(CACHE_KEYS.portalFeatures(tenantId))
  if (cached) return cached

  const payload = await withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, slug: true },
    })
    const settings = await tx.tenantSettings.findUniqueOrThrow({
      where: { tenantId },
      select: { branding: true, portalEnabled: true },
    })

    const branding = (settings.branding ?? {}) as Record<string, unknown>
    return {
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
      brandColor: typeof branding.primaryColor === 'string' ? branding.primaryColor : null,
      portalEnabled: settings.portalEnabled,
    } satisfies PortalTenantResponse
  })

  await cacheSet(
    CACHE_KEYS.portalFeatures(tenantId),
    payload,
    CACHE_TTL_SECONDS.portalFeatures,
  )
  return payload
}
