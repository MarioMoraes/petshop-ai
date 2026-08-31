import { withTenant } from '@petshop/db'
import {
  SITE_PUBLISH_REQUIREMENT_LABELS,
  SITE_ROUTING_KEYS,
  type SitePublishRequirement,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/events.js'
import { missingPublishData } from '../../lib/errors.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { readSiteRow, toDto, type SiteSettingsDto } from './content.js'
import { buildPayload, missingRequirements } from './public-payload.js'
import { refreshSite } from './revalidate.js'

/**
 * Publicar e despublicar (MOD-SITE-01).
 *
 * A recusa por dados mínimos (AC-02) não é burocracia: publicar uma página que não
 * diz onde o petshop fica é pior que não ter página — quem chega nela conclui que o
 * negócio não existe mais. Por isso o 422 lista **o que falta**, em vez de dizer
 * "dados incompletos" e mandar o admin caçar o campo pelas telas.
 */

async function tenantOf(tenantId: string): Promise<{ id: string; slug: string; name: string }> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true },
    })
    return row
  })
}

function describeMissing(missing: SitePublishRequirement[]): string {
  const labels = missing.map((item) => SITE_PUBLISH_REQUIREMENT_LABELS[item])
  return `Falta preencher: ${labels.join('; ')}.`
}

export async function publishSite(actor: ActorContext): Promise<SiteSettingsDto> {
  const tenant = await tenantOf(actor.tenantId)

  const row = await withTenant(
    actor.tenantId,
    async (tx) => {
      const { site } = await buildPayload(tx, tenant)
      const missing = missingRequirements(site)
      if (missing.length > 0) {
        throw missingPublishData(describeMissing(missing), { missing })
      }

      const before = await readSiteRow(tx, actor.tenantId)
      // `published_at` é a data em que o site passou a existir e **não** se reescreve
      // a cada republicação: é métrica, não estado.
      const publishedAt = before?.publishedAt ?? new Date()

      const updated = await tx.siteSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          published: true,
          publishedAt,
          updatedBy: actor.actorUserId ?? null,
        },
        update: { published: true, publishedAt, updatedBy: actor.actorUserId ?? null },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'site.published',
        entity: 'site_settings',
        entityId: actor.tenantId,
        before: { published: before?.published ?? false },
        after: { published: true },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return updated
    },
    tenantOptions(actor),
  )

  await refreshSite(actor.tenantId)
  await publishEvent(SITE_ROUTING_KEYS.sitePublicado, {
    tenantId: actor.tenantId,
    slug: tenant.slug,
    actorId: actor.actorUserId ?? null,
  })

  recordMetric({ metric: 'site_published', tenantId: actor.tenantId, value: 1, unit: 'count' })
  logger.info({ tenantId: actor.tenantId, slug: tenant.slug }, 'site publicado')

  return toDto(row)
}

export async function unpublishSite(actor: ActorContext): Promise<SiteSettingsDto> {
  const tenant = await tenantOf(actor.tenantId)

  const row = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await readSiteRow(tx, actor.tenantId)

      const updated = await tx.siteSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, published: false, updatedBy: actor.actorUserId ?? null },
        update: { published: false, updatedBy: actor.actorUserId ?? null },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'site.unpublished',
        entity: 'site_settings',
        entityId: actor.tenantId,
        before: { published: before?.published ?? false },
        after: { published: false },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return updated
    },
    tenantOptions(actor),
  )

  // A ordem importa: o Redis do serviço é descartado antes de o Next ser mandado
  // refazer a página, senão ele recarregaria do cache a mesma página que saiu do ar.
  // `refreshSite` faz as duas coisas, nessa ordem.
  await refreshSite(actor.tenantId)
  await publishEvent(SITE_ROUTING_KEYS.siteDespublicado, {
    tenantId: actor.tenantId,
    slug: tenant.slug,
    actorId: actor.actorUserId ?? null,
  })

  return toDto(row)
}
