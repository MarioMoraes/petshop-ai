import { NextResponse } from 'next/server'
import { ApiError } from '@petshop/api-client'
import { PRODUCT_KINDS, type ProductKind } from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * O PDF da posição do estoque (MOD-ESTOQUE-11), servido pelo Next.
 *
 * A ponte de `cobranca/pdf/[relatorio]/route.ts`, pelas mesmas razões: o browser nunca
 * fala com o gateway, e o resultado é um arquivo, e não dados para a página. O único
 * parâmetro aceito é o tipo, conferido contra a lista — o resto da query não viaja.
 */
export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind')
  const query = PRODUCT_KINDS.includes(kind as ProductKind) ? { kind: kind as ProductKind } : {}

  try {
    const file = await serverApi().downloadInventoryPositionPdf(query)
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        // O custo de compra é o segredo comercial do petshop.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // O navegador espera um arquivo: um texto com o status certo é o que ele mostra.
    if (error instanceof ApiError) {
      return new NextResponse(error.message, {
        status: error.status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    throw error
  }
}
