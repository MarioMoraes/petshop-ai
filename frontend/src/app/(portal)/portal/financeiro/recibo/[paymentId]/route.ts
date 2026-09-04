import { NextResponse } from 'next/server'
import { PortalError, readOwnReceipt } from '@/lib/portal-api'

/**
 * A entrega do recibo ao navegador (AC-03 de MOD-PORTAL-08).
 *
 * Precisa ser uma rota do Next, e não um `<a href>` para o gateway: o token do Clerk
 * mora no servidor deste processo, e um link direto chegaria lá sem `Authorization` e
 * voltaria 401. Mesma razão pela qual os relatórios do MOD-COBRANCA ganharam
 * `/cobranca/pdf/[relatorio]`.
 *
 * A diferença para aqueles é o que desce: lá, os bytes do PDF; aqui, um **302 para a
 * URL assinada** do bucket. O recibo é peça contábil já arquivada, com retenção de
 * cinco anos — não há documento a gerar na hora, só um endereço de vida curta a
 * assinar. E a assinatura não passa pela página: existe apenas neste salto, e não fica
 * no HTML nem no histórico de navegação.
 *
 * Os dois desvios de volta para a tela são deliberados. Recibo sem arquivo e falha de
 * infraestrutura não podem terminar numa aba em branco com um JSON — quem clicou queria
 * um comprovante e precisa ler por que ele não veio.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const { paymentId } = await params

  // A base é a **origem desta requisição**, e não uma variável de ambiente: o Portal é
  // servido no host do tenant (`petshopdojoao.{dominio}`), e um destino montado a partir
  // de `APP_DOMAIN` jogaria o tutor no host do Admin.
  const origem = new URL(request.url).origin

  try {
    const receipt = await readOwnReceipt(paymentId)

    if (!receipt.url) {
      return NextResponse.redirect(new URL('/portal/financeiro?recibo=preparo', origem))
    }

    return NextResponse.redirect(receipt.url)
  } catch (error) {
    // 404 aqui é pagamento que não é deste tutor (RN-03), e ele não merece tratamento
    // diferente de uma falha de infraestrutura: distinguir os dois na tela diria a
    // quem tentou adivinhar um id que aquele pagamento existe.
    const destino =
      error instanceof PortalError && error.status === 401
        ? '/portal/vincular'
        : '/portal/financeiro?recibo=erro'

    return NextResponse.redirect(new URL(destino, origem))
  }
}
