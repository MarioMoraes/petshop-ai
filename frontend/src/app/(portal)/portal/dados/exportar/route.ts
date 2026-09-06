import { NextResponse } from 'next/server'
import { PortalError, downloadOwnDataPdf, exportOwnData } from '@/lib/portal-api'

/**
 * A entrega do arquivo de dados ao navegador (AC-04 de MOD-PORTAL-09).
 *
 * Precisa ser uma rota do Next, e não um `<a href>` para o gateway: o token do Clerk mora
 * no servidor deste processo, e um link direto chegaria lá sem `Authorization` e voltaria
 * 401. Mesma razão do recibo em `/portal/financeiro/recibo/[paymentId]`.
 *
 * A diferença para o recibo é o que desce: lá, um 302 para a URL assinada de um PDF que já
 * existe no bucket; aqui, **os bytes**, montados na hora. Não há arquivo a assinar — o
 * documento é o retrato da ficha neste instante, e guardá-lo em algum lugar criaria uma
 * segunda cópia dos dados pessoais do titular só para poder entregá-los a ele.
 *
 * **Dois formatos, e a razão de manter os dois.** O padrão é PDF, porque quem clica é uma
 * pessoa querendo ler o que o petshop sabe sobre ela — e um JSON aberto no celular não é
 * leitura, é despejo. O `?formato=json` continua ali porque o art. 19 da LGPD fala em
 * formato estruturado e de leitura por máquina: é ele que outro fornecedor consegue
 * importar, e é ele que serve se um dia a folha for contestada. O direito é o mesmo nos
 * dois caminhos; o que muda é quem vai ler.
 *
 * `Content-Disposition: attachment` é o que faz o navegador salvar em vez de renderizar.
 */
export async function GET(request: Request) {
  // A base é a **origem desta requisição**, e não uma variável de ambiente: o Portal é
  // servido no host do tenant, e um destino montado a partir de `APP_DOMAIN` jogaria o
  // tutor no host do Admin.
  const origem = new URL(request.url).origin
  const formato = new URL(request.url).searchParams.get('formato')

  try {
    if (formato === 'json') {
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
    }

    const documento = await downloadOwnDataPdf()

    return new NextResponse(documento.bytes as unknown as BodyInit, {
      headers: {
        'content-type': documento.contentType,
        'content-disposition': `attachment; filename="${documento.filename}"`,
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
