import { NextResponse } from 'next/server'
import { PortalError, downloadOwnStatementPdf } from '@/lib/portal-api'

/**
 * O extrato da conta em PDF, entregue ao navegador (AC-02 de MOD-DOC-09).
 *
 * Precisa ser uma rota do Next, e não um `<a href>` para o gateway: o token do Clerk mora
 * no servidor deste processo, e um link direto chegaria lá sem `Authorization` e voltaria
 * 401. Mesma razão do recibo e da exportação de dados.
 *
 * A diferença para o recibo é o que desce: lá, um 302 para a URL assinada de um PDF que
 * já existe no bucket; aqui, os **bytes**, montados na hora. O extrato não é arquivado —
 * ele descreve o presente, e guardá-lo produziria um arquivo que contradiz o sistema no
 * dia seguinte.
 */
export async function GET(request: Request) {
  // A base é a **origem desta requisição**, e não uma variável de ambiente: o Portal é
  // servido no host do tenant, e um destino montado a partir de `APP_DOMAIN` jogaria o
  // tutor no host do Admin.
  const origem = new URL(request.url).origin

  try {
    const documento = await downloadOwnStatementPdf()

    return new NextResponse(documento.bytes as unknown as BodyInit, {
      headers: {
        'content-type': documento.contentType,
        'content-disposition': `attachment; filename="${documento.filename}"`,
        // O extrato é a conta corrente do titular, e o aparelho pode não ser só dele.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    const destino =
      error instanceof PortalError && error.status === 401
        ? '/portal/vincular'
        : '/portal/financeiro?extrato=erro'

    return NextResponse.redirect(new URL(destino, origem))
  }
}
