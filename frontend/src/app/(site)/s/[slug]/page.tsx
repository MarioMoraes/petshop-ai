import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { formatBRL, formatPhoneBR, type PublicSiteResponse } from '@petshop/shared-types'
import { fetchPublicSite, SiteNotFoundError } from '@/lib/site-api'
import { paletteOf, type SitePalette } from './branding'
import { groupBusinessHours } from './hours'
import { LeadForm } from './lead-form'
import { OpenNow } from './open-now'

/**
 * O site do estabelecimento (MOD-SITE-01, 03, 05, 06, 07).
 *
 * O visitante chega por `petshopdojoao.{dominio}/`; o middleware reescreve para cá com
 * o slug que resolveu do host. Nada nesta página é conteúdo próprio duplicado: nome,
 * cores, endereço, telefone, horário e serviços vêm da fonte única que o petshop já
 * mantém no Admin (RN-01). Os únicos textos exclusivos do site são quatro, e todos
 * opcionais.
 *
 * `revalidate = 600`: a página é HTML pronto, servido de cache. Quando o admin muda o
 * horário, o evento chega ao `tenant-site-service`, que chama `/api/site/revalidate` e
 * a página se refaz em segundos — sem ninguém tocar no site (AC-02 de MOD-SITE-06).
 */

export const revalidate = 600

interface PageProps {
  params: Promise<{ slug: string }>
}

async function loadSite(slug: string): Promise<PublicSiteResponse> {
  try {
    return await fetchPublicSite(slug)
  } catch (error) {
    // Site despublicado, tenant inativo ou host desconhecido: **404 nos três casos**
    // (RN-06). Distinguir entregaria a um visitante anônimo informação sobre a
    // instalação. Um serviço fora do ar também cai aqui, e nesse caso o que salva a
    // página é o cache do `fetch` — que é justamente o AC-04 de MOD-SITE-11.
    if (error instanceof SiteNotFoundError) notFound()
    throw error
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params

  try {
    const site = await fetchPublicSite(slug)
    return {
      title: site.seo.title,
      description: site.seo.description,
      alternates: { canonical: site.seo.canonicalUrl },
      openGraph: {
        title: site.seo.title,
        description: site.seo.description,
        url: site.seo.canonicalUrl,
        siteName: site.tenant.name,
        locale: 'pt_BR',
        type: 'website',
        ...(site.seo.ogImageUrl ? { images: [{ url: site.seo.ogImageUrl }] } : {}),
      },
    }
  } catch {
    // Página que não existe não se indexa, e o metadado dela não pode vazar o nome do
    // estabelecimento que está fora do ar.
    return { title: 'Página não encontrada', robots: { index: false, follow: false } }
  }
}

export default async function TenantSitePage({ params }: PageProps) {
  const { slug } = await params
  const site = await loadSite(slug)
  const palette = paletteOf(site.branding)

  return (
    <>
      <JsonLd site={site} />

      <div
        className="min-h-[100svh] bg-white text-ink"
        style={{ ['--brand' as string]: palette.brand }}
      >
        <SiteHeader site={site} palette={palette} />
        {site.content.notice ? <NoticeBand text={site.content.notice} palette={palette} /> : null}
        <Hero site={site} palette={palette} />
        <Services site={site} palette={palette} />
        {site.cta.taxiHighlighted ? <TaxiHighlight site={site} palette={palette} /> : null}
        <HoursAndPlace site={site} palette={palette} />
        {site.photos.length > 0 ? <Gallery site={site} /> : null}
        {site.cta.leadFormEnabled ? <Contact site={site} palette={palette} /> : null}
        <SiteFooter site={site} />
      </div>
    </>
  )
}

// ─── Peças ───────────────────────────────────────────────────────────────────

const SECTION = 'mx-auto w-full max-w-5xl px-6'

function whatsappHref(site: PublicSiteResponse): string | null {
  if (!site.contact.whatsapp) return null
  const digits = site.contact.whatsapp.replace(/\D/g, '')
  const text = encodeURIComponent(`Olá! Vim pelo site do ${site.tenant.name}.`)
  return `https://wa.me/${digits}?text=${text}`
}

function SiteHeader({ site, palette }: { site: PublicSiteResponse; palette: SitePalette }) {
  const whatsapp = whatsappHref(site)

  return (
    <header className="border-b" style={{ borderColor: palette.line }}>
      <div className={`${SECTION} flex flex-wrap items-center justify-between gap-4 py-5`}>
        <div className="flex items-center gap-3">
          {site.branding.logoUrl ? (
            // Logo do tenant, hospedado fora: `<img>` e não `next/image` de propósito —
            // otimizar exigiria liberar o domínio de cada petshop na configuração do Next.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={site.branding.logoUrl}
              alt={site.tenant.name}
              className="h-10 w-auto max-w-[160px] object-contain"
            />
          ) : (
            <span
              className="grid size-10 place-items-center rounded-2xl text-sm font-semibold"
              style={{ backgroundColor: palette.brand, color: palette.onBrand }}
            >
              {site.tenant.name.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="text-base font-semibold">{site.tenant.name}</span>
        </div>

        <div className="flex items-center gap-3">
          <OpenNow businessHours={site.businessHours} timezone={site.tenant.timezone} />
          {whatsapp ? (
            <a
              href={whatsapp}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{ backgroundColor: palette.brand, color: palette.onBrand }}
            >
              WhatsApp
            </a>
          ) : null}
        </div>
      </div>
    </header>
  )
}

/** A faixa temporária: "fechados dia 25". Some sozinha quando o admin apaga o texto. */
function NoticeBand({ text, palette }: { text: string; palette: SitePalette }) {
  return (
    <div style={{ backgroundColor: palette.brand, color: palette.onBrand }}>
      <p className={`${SECTION} py-2.5 text-center text-sm font-medium`}>{text}</p>
    </div>
  )
}

function Hero({ site, palette }: { site: PublicSiteResponse; palette: SitePalette }) {
  const whatsapp = whatsappHref(site)
  const hero = site.photos.find((photo) => photo.kind === 'HERO') ?? site.photos[0]
  const city = site.address?.city

  return (
    <section className={`${SECTION} grid gap-10 py-14 md:grid-cols-[1.1fr_1fr] md:items-center`}>
      <div>
        <h1 className="font-serif text-4xl leading-[1.1] text-ink md:text-5xl">
          {site.content.headline ??
            `Cuidado de verdade para o seu pet${city ? `, em ${city}` : ''}.`}
        </h1>

        {site.content.about ? (
          <p className="mt-5 max-w-prose text-base leading-relaxed text-muted">
            {site.content.about}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {/*
            O botão principal só é "Agendar" quando há Portal a alcançar. Com o
            agendamento online desligado ele vira WhatsApp — e não um "Agendar" que
            leva a uma porta fechada (AC-02 de MOD-SITE-07).
          */}
          {site.cta.bookingUrl ? (
            <a
              href={site.cta.bookingUrl}
              className="rounded-full px-6 py-3 text-sm font-semibold"
              style={{ backgroundColor: palette.brand, color: palette.onBrand }}
            >
              Agendar horário
            </a>
          ) : whatsapp ? (
            <a
              href={whatsapp}
              className="rounded-full px-6 py-3 text-sm font-semibold"
              style={{ backgroundColor: palette.brand, color: palette.onBrand }}
            >
              Falar no WhatsApp
            </a>
          ) : null}

          {site.contact.phone ? (
            <a
              href={`tel:${site.contact.phone}`}
              className="rounded-full border px-6 py-3 text-sm font-semibold text-ink"
              style={{ borderColor: palette.line }}
            >
              {formatPhoneBR(site.contact.phone)}
            </a>
          ) : null}
        </div>
      </div>

      {hero ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={hero.url}
          alt={hero.alt ?? `Fachada do ${site.tenant.name}`}
          className="aspect-[4/3] w-full rounded-3xl object-cover"
        />
      ) : (
        <div
          className="aspect-[4/3] w-full rounded-3xl"
          style={{ backgroundColor: palette.tint }}
          aria-hidden
        />
      )}
    </section>
  )
}

function Services({ site, palette }: { site: PublicSiteResponse; palette: SitePalette }) {
  if (site.services.length === 0) return null

  return (
    <section style={{ backgroundColor: palette.tint }}>
      <div className={`${SECTION} py-14`}>
        <h2 className="text-2xl font-semibold text-ink">O que fazemos</h2>

        {/*
          `auto-fit` em vez de um número fixo de colunas: o petshop que anuncia dois
          serviços não pode receber dois cartões estreitos com um vão à direita, e o
          que anuncia oito não pode receber oito cartões espremidos. A largura mínima
          é que decide quantos cabem por linha.
        */}
        <ul className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
          {site.services.map((service) => (
            <li
              key={service.id}
              className="rounded-3xl border bg-white p-6"
              style={{ borderColor: palette.line }}
            >
              <h3 className="text-base font-semibold text-ink">{service.name}</h3>
              {service.description ? (
                <p className="mt-2 text-sm leading-relaxed text-muted">{service.description}</p>
              ) : null}

              {/*
                Piso, nunca preço exato (RN-04): o site não sabe qual é o pet. Serviço
                sem tabela aparece com "consulte" e não some — sumir esconderia do
                cliente um serviço que o petshop presta.
              */}
              <p className="mt-4 text-sm font-medium" style={{ color: palette.brand }}>
                {service.fromPriceCents === null
                  ? 'Consulte'
                  : `a partir de ${formatBRL(service.fromPriceCents)}`}
              </p>
            </li>
          ))}
        </ul>

        {site.services.some((service) => service.fromPriceCents !== null) ? (
          <p className="mt-6 text-xs text-muted">
            O valor final depende do porte e do tipo de pelo do seu pet.
          </p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * O leva-e-traz é destaque à parte: corrida não se agenda como se fosse um banho.
 *
 * O botão vem junto porque este bloco é o único lugar da página em que o visitante
 * descobre o serviço — e descobrir sem ter o que fazer a seguir é o mesmo que não
 * descobrir.
 */
function TaxiHighlight({
  site,
  palette,
}: {
  site: PublicSiteResponse
  palette: SitePalette
}) {
  const whatsapp = whatsappHref(site)

  return (
    <section className={`${SECTION} py-12`}>
      <div
        className="flex flex-wrap items-center justify-between gap-6 rounded-3xl border p-8"
        style={{ borderColor: palette.line, backgroundColor: palette.tint }}
      >
        <div className="max-w-prose">
          <h2 className="text-xl font-semibold text-ink">Buscamos e levamos seu pet</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            A gente passa aí, leva para o banho e devolve em casa. Combine o leva-e-traz
            junto com o horário.
          </p>
        </div>

        {whatsapp ? (
          <a
            href={whatsapp}
            className="rounded-full border bg-white px-5 py-2.5 text-sm font-semibold text-ink"
            style={{ borderColor: palette.line }}
          >
            Combinar pelo WhatsApp
          </a>
        ) : null}
      </div>
    </section>
  )
}

function HoursAndPlace({ site, palette }: { site: PublicSiteResponse; palette: SitePalette }) {
  const groups = groupBusinessHours(site.businessHours)
  const address = site.address

  const mapsHref = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${address.street}, ${address.number} — ${address.district}, ${address.city} ${address.state}`,
      )}`
    : null

  return (
    <section className={`${SECTION} grid gap-10 py-14 md:grid-cols-2`}>
      <div>
        <h2 className="text-2xl font-semibold text-ink">Horário</h2>
        <dl className="mt-6 grid gap-2">
          {groups.map((group) => (
            <div key={group.days} className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted">{group.days}</dt>
              <dd
                className="flex-1 border-b border-dotted text-right text-sm font-medium text-ink"
                style={{ borderColor: palette.line }}
              >
                {group.hours}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {address ? (
        <div>
          <h2 className="text-2xl font-semibold text-ink">Onde estamos</h2>
          <address className="mt-6 not-italic text-sm leading-relaxed text-muted">
            {address.street}, {address.number}
            {address.complement ? ` — ${address.complement}` : ''}
            <br />
            {address.district}, {address.city} — {address.state}
            <br />
            CEP {address.zipCode.replace(/^(\d{5})(\d{3})$/, '$1-$2')}
          </address>

          {mapsHref ? (
            <a
              href={mapsHref}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-flex rounded-full border px-5 py-2.5 text-sm font-semibold text-ink"
              style={{ borderColor: palette.line }}
            >
              Como chegar
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function Gallery({ site }: { site: PublicSiteResponse }) {
  const photos = site.photos.filter((photo) => photo.kind === 'GALLERY')
  if (photos.length === 0) return null

  return (
    <section className={`${SECTION} pb-14`}>
      <h2 className="text-2xl font-semibold text-ink">Por dentro</h2>
      <ul className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        {photos.map((photo) => (
          <li key={photo.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt={photo.alt ?? ''}
              loading="lazy"
              className="aspect-square w-full rounded-2xl object-cover"
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Contact({ site, palette }: { site: PublicSiteResponse; palette: SitePalette }) {
  return (
    <section style={{ backgroundColor: palette.tint }}>
      <div className={`${SECTION} py-14`}>
        <h2 className="text-2xl font-semibold text-ink">Fale com a gente</h2>
        <p className="mt-2 text-sm text-muted">
          Deixe seu contato que a gente retorna — ou chame no WhatsApp, se preferir.
        </p>

        <div className="mt-8">
          <LeadForm slug={site.tenant.slug} palette={palette} />
        </div>
      </div>
    </section>
  )
}

function SiteFooter({ site }: { site: PublicSiteResponse }) {
  // O petshop pequeno atende e dispara pelo mesmo aparelho, e aí os dois campos
  // trazem o mesmo número: repeti-lo lado a lado no rodapé faria a página parecer
  // montada por engano. Um número, um link.
  const sameNumber = site.contact.phone === site.contact.whatsapp

  return (
    <footer className="border-t border-line">
      <div className={`${SECTION} flex flex-wrap items-center justify-between gap-4 py-8`}>
        <p className="text-sm text-muted">
          {site.content.footerNote ?? `${site.tenant.name} — todos os direitos reservados`}
        </p>
        <div className="flex flex-wrap items-center gap-5 text-sm text-muted">
          {site.contact.phone ? (
            <a href={`tel:${site.contact.phone}`} className="hover:underline">
              {formatPhoneBR(site.contact.phone)}
            </a>
          ) : null}
          {site.contact.whatsapp && !sameNumber ? (
            <a href={whatsappHref(site) ?? '#'} className="hover:underline">
              {formatPhoneBR(site.contact.whatsapp)} · WhatsApp
            </a>
          ) : null}
        </div>
      </div>
    </footer>
  )
}

/**
 * Dados estruturados (AC-02 de MOD-SITE-10).
 *
 * É o que permite ao buscador mostrar horário e endereço direto no resultado — e é a
 * razão prática de o MOD-SITE-02 existir. O objeto é serializado com `JSON.stringify`,
 * que escapa o conteúdo: nome e endereço são texto do admin, e texto do admin nunca
 * entra como marcação.
 */
function JsonLd({ site }: { site: PublicSiteResponse }) {
  const prices = site.services
    .map((service) => service.fromPriceCents)
    .filter((price): price is number => price !== null)

  const data = {
    '@context': 'https://schema.org',
    '@type': 'PetStore',
    name: site.tenant.name,
    url: site.seo.canonicalUrl,
    ...(site.seo.ogImageUrl ? { image: site.seo.ogImageUrl } : {}),
    ...(site.contact.phone ?? site.contact.whatsapp
      ? { telephone: site.contact.phone ?? site.contact.whatsapp }
      : {}),
    ...(site.address
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: `${site.address.street}, ${site.address.number}`,
            addressLocality: site.address.city,
            addressRegion: site.address.state,
            postalCode: site.address.zipCode,
            addressCountry: 'BR',
          },
        }
      : {}),
    ...(prices.length > 0 ? { priceRange: `A partir de R$ ${Math.min(...prices) / 100}` } : {}),
    openingHoursSpecification: Object.entries(site.businessHours)
      .filter(([, day]) => !day.closed)
      .map(([weekday, day]) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}`,
        opens: day.opensAt,
        closes: day.closesAt,
      })),
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}
