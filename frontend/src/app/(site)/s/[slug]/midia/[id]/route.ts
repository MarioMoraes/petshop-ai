import { NextResponse } from 'next/server'
import { fetchSitePhoto } from '@/lib/site-api'

/**
 * As fotos da galeria, servidas pelo host do tenant.
 *
 * **Por que passar por aqui em vez de apontar direto para o R2.** O bucket é privado, e
 * o álbum do pet resolve isso com URL assinada de 15 minutos — o que não serve aqui:
 * a página fica em cache por dez minutos e o `og:image` é buscado pelo buscador dias
 * depois. Uma URL que morre não sobrevive a nenhum dos dois. Esta rota dá à foto um
 * endereço estável no domínio do petshop, e o bucket continua fechado.
 *
 * O cache é longo porque a URL é versionada: trocar a foto muda `updated_at`, muda o
 * `?v=`, e o navegador que guardou a anterior por um ano não fica preso a ela.
 */

export const revalidate = 3600

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params
  const photo = await fetchSitePhoto(slug, id)

  if (!photo) {
    return new NextResponse('Não encontrado', { status: 404 })
  }

  return new NextResponse(photo.body, {
    headers: {
      'content-type': photo.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}
