import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { siteTag } from '@/lib/site-api'

/**
 * A revalidação sob demanda (AC-03 de MOD-SITE-11).
 *
 * Quem chama é o módulo do site no backend, ao publicar, despublicar ou receber
 * `tenant.configuracao.atualizada` / `agenda.servico.alterado`. Sem isto, o horário
 * corrigido às 9h apareceria ao meio-dia, pelo TTL.
 *
 * **O segredo não protege dado nenhum** — a página é pública. Protege custo: sem ele,
 * qualquer um na rede interna força re-render de todos os sites em laço. A comparação
 * é curta e o segredo não vai na resposta.
 *
 * A rota vive no grupo `(site)` porque é do site que ela fala; o middleware a deixa
 * passar pelo mesmo caminho de `/api/health`.
 */

const SECRET = process.env.SITE_REVALIDATE_SECRET ?? 'dev-site-revalidate-secret'

export async function POST(request: Request) {
  if (request.headers.get('x-site-revalidate-secret') !== SECRET) {
    return NextResponse.json({ error: 'não autorizado' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as { slug?: unknown } | null
  const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  if (!slug) return NextResponse.json({ error: 'slug ausente' }, { status: 422 })

  revalidateTag(siteTag(slug))
  return NextResponse.json({ revalidated: true, slug })
}
