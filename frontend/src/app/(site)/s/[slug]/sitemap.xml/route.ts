import { NextResponse } from 'next/server'
import { fetchPublicSite } from '@/lib/site-api'

/**
 * O sitemap daquele petshop (AC-03 de MOD-SITE-10).
 *
 * Por tenant, e não da plataforma: cada host é um site, e um sitemap único listando
 * todos os estabelecimentos entregaria a lista de clientes a quem pedisse.
 *
 * Site fora do ar responde 404 — sitemap de página despublicada é convite a manter no
 * índice o que saiu do ar.
 */

export const revalidate = 3600

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  const site = await fetchPublicSite(slug).catch(() => null)
  if (!site) return new NextResponse('Não encontrado', { status: 404 })

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${site.seo.canonicalUrl}</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`

  return new NextResponse(body, {
    headers: { 'content-type': 'application/xml', 'cache-control': 'public, max-age=3600' },
  })
}
