import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  BrandingSchema,
  BusinessHoursSchema,
  DEFAULT_BRANDING,
  DEFAULT_BUSINESS_HOURS,
  SITE_PUBLISH_REQUIREMENTS,
  type Branding,
  type BusinessHours,
  type PublicSiteResponse,
  type SitePublishRequirement,
  type TenantAddress,
} from '@petshop/shared-types'
import { canonicalUrlOf } from './canonical.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../shared/redis.js'
import { notFound } from './errors.js'
import { readSiteRow, toContent } from './content.js'
import { photoUrl } from './photo-url.js'
import { resolveTenant, type ResolvedTenant } from './resolve.js'

/**
 * O payload da página, montado de uma vez (PRD §5).
 *
 * **Uma resposta inteira, e não seis chamadas.** A página é renderizada a cada
 * revalidação; seis idas ao banco por render multiplicariam por seis o custo de um
 * site que precisa ser rápido no 4G da calçada. É exatamente o caso em que o BFF vale
 * a pena.
 *
 * **Nada aqui é dado de cliente (RN-03).** Nenhuma consulta a `tutors`, `pets`,
 * `appointments` ou `ledger_entries`: a superfície pública não tem caminho até eles
 * nem por engano. A única exceção do módulo inteiro é o `phone_hash` do lead, que
 * compara hashes e não devolve nada ao visitante.
 */

interface SettingsRow {
  timezone: string
  branding: unknown
  businessHours: unknown
  onlineBookingEnabled: boolean
  addressZip: string | null
  addressStreet: string | null
  addressNumber: string | null
  addressComplement: string | null
  addressDistrict: string | null
  addressCity: string | null
  addressState: string | null
  publicPhone: string | null
  publicWhatsapp: string | null
}

const SETTINGS_SELECT = {
  timezone: true,
  branding: true,
  businessHours: true,
  onlineBookingEnabled: true,
  addressZip: true,
  addressStreet: true,
  addressNumber: true,
  addressComplement: true,
  addressDistrict: true,
  addressCity: true,
  addressState: true,
  publicPhone: true,
  publicWhatsapp: true,
} as const

/**
 * O endereço é tudo-ou-nada: o CHECK `tenant_settings_address_complete` garante no
 * banco, e aqui basta olhar um campo obrigatório para saber se há endereço.
 */
function toAddress(row: SettingsRow): TenantAddress | null {
  if (!row.addressZip || !row.addressStreet || !row.addressCity || !row.addressState) return null
  return {
    zipCode: row.addressZip,
    street: row.addressStreet,
    number: row.addressNumber ?? '',
    complement: row.addressComplement,
    district: row.addressDistrict ?? '',
    city: row.addressCity,
    state: row.addressState,
  }
}

/**
 * Configuração corrompida não pode derrubar a página pública.
 *
 * `branding` e `business_hours` são JSON livre no banco. Um valor fora de forma —
 * migração antiga, escrita manual — faria o `parse` estourar e o site inteiro cair
 * com 500. Cair no padrão é pior que o valor certo e melhor que uma página fora do ar.
 */
function toBranding(value: unknown): Branding {
  const parsed = BrandingSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_BRANDING
}

function toBusinessHours(value: unknown): BusinessHours {
  const parsed = BusinessHoursSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_BUSINESS_HOURS
}

/**
 * O que falta para publicar (AC-02 de MOD-SITE-01).
 *
 * Três coisas, e cada uma tem razão de estar aqui: sem endereço, quem chega na página
 * conclui que o negócio não existe mais; sem telefone, não há como agir depois de ler;
 * sem serviço visível, a página não diz o que o petshop faz.
 */
export function missingRequirements(site: PublicSiteResponse): SitePublishRequirement[] {
  const missing: SitePublishRequirement[] = []
  if (!site.address) missing.push('address')
  if (!site.contact.phone && !site.contact.whatsapp) missing.push('contact')
  if (site.services.length === 0) missing.push('service')
  return missing.filter((item) => SITE_PUBLISH_REQUIREMENTS.includes(item))
}

/** Metadados derivados (AC-01 de MOD-SITE-10); o admin pode sobrescrevê-los. */
function deriveSeo(
  tenant: ResolvedTenant,
  address: TenantAddress | null,
  services: PublicSiteResponse['services'],
  content: ReturnType<typeof toContent>,
  ogImageUrl: string | null,
): PublicSiteResponse['seo'] {
  const city = address?.city
  const title = content.seoTitle ?? (city ? `${tenant.name} — Pet shop em ${city}` : tenant.name)

  const serviceNames = services.slice(0, 3).map((service) => service.name)
  const derived =
    serviceNames.length > 0
      ? `${serviceNames.join(', ')}${city ? ` em ${city}` : ''}. Agende pelo site.`
      : `${tenant.name}${city ? ` — ${city}` : ''}. Fale com a gente.`

  return {
    title: title.slice(0, 60),
    description: (content.seoDescription ?? content.about ?? derived).slice(0, 160),
    canonicalUrl: canonicalUrlOf(tenant.slug),
    ogImageUrl,
  }
}

export async function buildPayload(
  tx: TenantTransaction,
  tenant: ResolvedTenant,
): Promise<{ site: PublicSiteResponse; published: boolean }> {
  const [settings, siteRow, photoRows, serviceRows, taxi] = await Promise.all([
    tx.tenantSettings.findUnique({ where: { tenantId: tenant.id }, select: SETTINGS_SELECT }),
    readSiteRow(tx, tenant.id),
    tx.sitePhoto.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, alt: true, kind: true, position: true, updatedAt: true },
    }),
    // A vitrine é subconjunto do catálogo, não espelho dele (AC-04). `TAXI` nunca
    // entra: o leva-e-traz aparece como destaque à parte, porque corrida não se
    // agenda como se fosse um banho.
    tx.service.findMany({
      where: {
        deletedAt: null,
        active: true,
        showOnSite: true,
        category: { not: 'TAXI' },
      },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        pricing: { select: { priceCents: true } },
      },
    }),
    tx.taxiSettings.findUnique({
      where: { tenantId: tenant.id },
      select: { enabled: true },
    }),
  ])

  const content = toContent(siteRow)
  const branding = toBranding(settings?.branding)
  const address = settings ? toAddress(settings) : null

  const photos = photoRows.map((row) => ({
    id: row.id,
    url: photoUrl(tenant.slug, row.id, row.updatedAt),
    alt: row.alt,
    kind: row.kind,
    position: row.position,
  }))

  const services = serviceRows.map((row) => {
    // `MIN(price_cents)` rotulado "a partir de" (RN-04). Serviço sem tabela de preço
    // aparece com "consulte" e **não some**: sumir esconderia do cliente um serviço
    // que o petshop presta (AC-02 de MOD-SITE-05).
    //
    // **Preço zero é preço não preenchido, não preço grátis.** A tela de serviços cria
    // uma linha por porte e o petshop preenche as que usa; a que ficou em branco vale
    // zero no banco. Sem este filtro, um banho de R$ 60 a R$ 90 com o porte gigante em
    // branco anunciaria "a partir de R$ 0,00" — e o site que deveria trazer o cliente
    // seria o motivo de ele não vir.
    const prices = row.pricing
      .map((price) => Number(price.priceCents))
      .filter((price) => price > 0)

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      fromPriceCents: content.showPrices && prices.length > 0 ? Math.min(...prices) : null,
    }
  })

  const ogImageUrl = branding.logoUrl ?? photos[0]?.url ?? null

  const site: PublicSiteResponse = {
    tenant: {
      name: tenant.name,
      slug: tenant.slug,
      timezone: settings?.timezone ?? 'America/Sao_Paulo',
    },
    branding,
    address,
    contact: {
      phone: settings?.publicPhone ?? null,
      whatsapp: settings?.publicWhatsapp ?? null,
    },
    businessHours: toBusinessHours(settings?.businessHours),
    content,
    photos,
    services,
    cta: {
      // O botão principal só leva ao Portal quando há Portal a alcançar; senão vira
      // "Falar no WhatsApp", e não um "Agendar" que abre uma porta fechada (AC-02 de
      // MOD-SITE-07). O `/portal` é rota do mesmo host — o MOD-PORTAL a constrói.
      bookingUrl: settings?.onlineBookingEnabled
        ? `${canonicalUrlOf(tenant.slug)}/portal`
        : null,
      taxiHighlighted: taxi?.enabled ?? false,
      leadFormEnabled: content.leadFormEnabled,
    },
    seo: deriveSeo(tenant, address, services, content, ogImageUrl),
  }

  return { site, published: siteRow?.published ?? false }
}

/**
 * O payload público, com cache.
 *
 * Site despublicado responde **404, e não 403 nem uma página de "em construção"**
 * (AC-03 de MOD-SITE-01): quem pediu não tem por que saber que existe um site ali
 * esperando alguém apertar um botão.
 */
export async function getPublicSite(slug: string): Promise<PublicSiteResponse> {
  const tenant = await resolveTenant(slug)

  const cached = await cacheGet<PublicSiteResponse>(CACHE_KEYS.publicSite(tenant.id))
  if (cached) return cached

  const { site, published } = await withTenant(tenant.id, (tx) => buildPayload(tx, tenant))
  if (!published) throw notFound()

  await cacheSet(CACHE_KEYS.publicSite(tenant.id), site, CACHE_TTL_SECONDS.publicSite)
  return site
}

/** A pré-visualização do Admin: monta a página mesmo despublicada, e sem cache. */
export async function getPreview(
  tenantId: string,
): Promise<{ site: PublicSiteResponse; published: boolean; missing: SitePublishRequirement[] }> {
  const tenant = await withTenant(tenantId, async (tx) => {
    const row = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true },
    })
    if (!row) throw notFound()
    return row
  })

  const { site, published } = await withTenant(tenantId, (tx) => buildPayload(tx, tenant))
  return { site, published, missing: missingRequirements(site) }
}
