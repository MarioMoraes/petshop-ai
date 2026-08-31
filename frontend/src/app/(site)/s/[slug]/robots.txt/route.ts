import { NextResponse } from 'next/server'
import { ADMIN_ROUTE_PREFIXES, PORTAL_PREFIX } from '@/lib/host'
import { fetchPublicSite } from '@/lib/site-api'

/**
 * O `robots.txt` daquele host (AC-03 de MOD-SITE-10).
 *
 * Libera a página pública e bloqueia **todo caminho autenticado**. A lista de bloqueio
 * sai de `ADMIN_ROUTE_PREFIXES`, a mesma que o roteamento por host usa: uma tela nova
 * do Admin entra no robots pelo mesmo movimento que a tira do host do tenant, sem
 * ninguém precisar lembrar dos dois lugares.
 *
 * Site fora do ar responde `Disallow: /` — página despublicada que continua indexada é
 * pior que nunca ter existido (AC-04).
 */

export const revalidate = 3600

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const site = await fetchPublicSite(slug).catch(() => null)

  if (!site) {
    return new NextResponse('User-agent: *\nDisallow: /\n', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex' },
    })
  }

  const blocked = [PORTAL_PREFIX, ...ADMIN_ROUTE_PREFIXES]
    .map((prefix) => `Disallow: ${prefix}/`)
    .join('\n')

  const body = `User-agent: *
Allow: /
${blocked}

Sitemap: ${site.seo.canonicalUrl}/sitemap.xml
`

  return new NextResponse(body, {
    headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' },
  })
}
