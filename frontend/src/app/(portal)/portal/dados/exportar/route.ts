import { NextResponse } from 'next/server'
import { PortalError, exportOwnData } from '@/lib/portal-api'

/**
 * A entrega do arquivo de dados ao navegador (AC-04 de MOD-PORTAL-09).
 *
 * Precisa ser uma rota do Next, e não um `<a href>` para o gateway: o token do Clerk mora
 * no servidor deste processo, e um link direto chegaria lá sem `Authorization` e voltaria
 * 401. Mesma razão do recibo em `/portal/financeiro/recibo/[paymentId]`.
 *
 * A diferença para o recibo é o que desce: lá, um 302 para a URL assinada de um PDF que já
 * existe no bucket; aqui, **os bytes**, montados na hora. Não há arquivo a assinar — o JSON
 * é o retrato da ficha neste instante, e guardá-lo em algum lugar criaria uma segunda cópia
 * dos dados pessoais do titular só para poder entregá-los a ele.
 *
 * `Content-Disposition: attachment` é o que faz o navegador salvar em vez de renderizar. Um
 * JSON aberto numa aba é ilegível para quem pediu "meus dados", e continua na tela do
 * celular que passa de mão em mão.
 */
export async function GET(request: Request) {
  // A base é a **origem desta requisição**, e não uma variável de ambiente: o Portal é
  // servido no host do tenant, e um destino montado a partir de `APP_DOMAIN` jogaria o
  // tutor no host do Admin.
  const origem = new URL(request.url).origin

  try {
    const dados = await exportOwnData()
    const arquivo = new Date().toISOString().slice(0, 10)

    return new NextResponse(JSON.stringify(dados, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="meus-dados-${arquivo}.json"`,
        // Dado pessoal não fica no cache de nenhum intermediário, e nem no do navegador:
        // o arquivo é do titular, e o aparelho pode não ser só dele.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    const destino =
      error instanceof PortalError && error.status === 401
        ? '/portal/vincular'
        : '/portal/dados?exportacao=erro'

    return NextResponse.redirect(new URL(destino, origem))
  }
}
