import { NextResponse } from 'next/server'
import { ApiError } from '@petshop/api-client'
import { serverApi } from '@/lib/api'

/**
 * O fechamento do caixa em PDF, servido pelo Next.
 *
 * A ponte de `estoque/posicao/pdf/route.ts`: o browser nunca fala com o gateway, e o
 * resultado é um arquivo. O id é conferido antes de viajar — um texto qualquer no
 * caminho viraria um 422 do backend com cara de erro de sistema.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) return new NextResponse('Caixa não encontrado', { status: 404 })

  try {
    const file = await serverApi().downloadCashSessionPdf(id)
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
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
