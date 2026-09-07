import { NextResponse } from 'next/server'
import { PortalError, readOwnDocument } from '@/lib/portal-api'

/**
 * A entrega de um documento ao navegador (AC-01 de MOD-DOC-10).
 *
 * Um **302 para a URL assinada**, como o recibo, e não os bytes: o documento já existe no
 * bucket, com retenção de cinco anos — não há folha a montar agora, só um endereço de
 * vida curta a assinar. A assinatura existe apenas neste salto: não passa pela página,
 * não fica no HTML nem no histórico de navegação.
 *
 * Pedi-la **é** o download, e é isso que a trilha do estabelecimento registra. Por isso o
 * endereço é buscado aqui, no clique, e não junto com a lista.
 *
 * Os dois desvios de volta para a tela são deliberados: documento em preparo e falha de
 * infraestrutura não podem terminar numa aba em branco com um JSON — quem clicou queria
 * um papel e precisa ler por que ele não veio.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params

  // A base é a **origem desta requisição**, e não uma variável de ambiente: o Portal é
  // servido no host do tenant, e um destino montado a partir de `APP_DOMAIN` jogaria o
  // tutor no host do Admin.
  const origem = new URL(request.url).origin

  try {
    const documento = await readOwnDocument(documentId)

    if (!documento.url) {
      return NextResponse.redirect(new URL('/portal/documentos?documento=preparo', origem))
    }

    return NextResponse.redirect(documento.url)
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) {
      return NextResponse.redirect(new URL('/portal/vincular', origem))
    }

    return NextResponse.redirect(new URL('/portal/documentos?documento=erro', origem))
  }
}
