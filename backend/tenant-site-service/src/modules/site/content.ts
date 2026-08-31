import { withTenant, type TenantTransaction } from '@petshop/db'
import { SiteContentSchema, type SiteContent, type SiteContentPatch } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { refreshSite } from './revalidate.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * Os textos e as chaves do site (MOD-SITE-03).
 *
 * A linha nasce sob demanda, na primeira leitura, e não no provisionamento do tenant:
 * o site nasce **despublicado**, e gravar uma linha de defaults para todo tenant novo
 * seria ruído numa tabela que só interessa a quem for publicar.
 *
 * Todo texto daqui é **texto puro**. Não há editor rico, não há HTML do usuário na
 * página e portanto não há XSS armazenado a defender — o `<b>` que o admin digitar
 * aparece literalmente, e isso é a resposta certa (AC-03).
 */

export interface SiteRow {
  published: boolean
  publishedAt: Date | null
  headline: string | null
  about: string | null
  notice: string | null
  footerNote: string | null
  showPrices: boolean
  leadFormEnabled: boolean
  seoTitle: string | null
  seoDescription: string | null
  updatedAt: Date
}

/** Os defaults, materializados sem gravar nada. */
export const CONTENT_DEFAULTS: SiteContent = SiteContentSchema.parse({})

export function toContent(row: SiteRow | null): SiteContent {
  if (!row) return CONTENT_DEFAULTS
  return {
    headline: row.headline,
    about: row.about,
    notice: row.notice,
    footerNote: row.footerNote,
    showPrices: row.showPrices,
    leadFormEnabled: row.leadFormEnabled,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  }
}

export async function readSiteRow(
  tx: TenantTransaction,
  tenantId: string,
): Promise<SiteRow | null> {
  return tx.siteSettings.findUnique({
    where: { tenantId },
    select: {
      published: true,
      publishedAt: true,
      headline: true,
      about: true,
      notice: true,
      footerNote: true,
      showPrices: true,
      leadFormEnabled: true,
      seoTitle: true,
      seoDescription: true,
      updatedAt: true,
    },
  })
}

export interface SiteSettingsDto extends SiteContent {
  published: boolean
  publishedAt: string | null
  updatedAt: string
}

export function toDto(row: SiteRow | null): SiteSettingsDto {
  return {
    ...toContent(row),
    published: row?.published ?? false,
    publishedAt: row?.publishedAt?.toISOString() ?? null,
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  }
}

export async function getSettings(actor: ActorContext): Promise<SiteSettingsDto> {
  return withTenant(actor.tenantId, async (tx) => toDto(await readSiteRow(tx, actor.tenantId)))
}

/**
 * PATCH parcial: o que não veio não muda.
 *
 * `SiteContentPatchSchema` é montado a partir de `SiteContentFields`, **sem**
 * `.default()`, porque `.partial()` no Zod não remove default — o schema completo,
 * parcializado, gravaria `showPrices: true` por cima do `false` que o tenant
 * escolheu, sem que o campo tivesse sido enviado. O mesmo defeito já apareceu uma vez
 * no PATCH de `tenant_settings`.
 */
export async function updateSettings(
  actor: ActorContext,
  input: SiteContentPatch,
): Promise<SiteSettingsDto> {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await readSiteRow(tx, actor.tenantId)

      const data = {
        ...(input.headline !== undefined ? { headline: input.headline ?? null } : {}),
        ...(input.about !== undefined ? { about: input.about ?? null } : {}),
        ...(input.notice !== undefined ? { notice: input.notice ?? null } : {}),
        ...(input.footerNote !== undefined ? { footerNote: input.footerNote ?? null } : {}),
        ...(input.showPrices !== undefined ? { showPrices: input.showPrices } : {}),
        ...(input.leadFormEnabled !== undefined
          ? { leadFormEnabled: input.leadFormEnabled }
          : {}),
        ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle ?? null } : {}),
        ...(input.seoDescription !== undefined
          ? { seoDescription: input.seoDescription ?? null }
          : {}),
        updatedBy: actor.actorUserId ?? null,
      }

      const row = await tx.siteSettings.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, ...data },
        update: data,
        select: {
          published: true,
          publishedAt: true,
          headline: true,
          about: true,
          notice: true,
          footerNote: true,
          showPrices: true,
          leadFormEnabled: true,
          seoTitle: true,
          seoDescription: true,
          updatedAt: true,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'site_settings.updated',
        entity: 'site_settings',
        entityId: actor.tenantId,
        before: toContent(before),
        after: toContent(row),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return row
    },
    tenantOptions(actor),
  )

  await refreshSite(actor.tenantId)
  return toDto(updated)
}
