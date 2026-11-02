import { NextResponse } from 'next/server'
import { ApiError } from '@petshop/api-client'
import { serverApi } from '@/lib/api'

/**
 * A ficha do pet em PDF (MOD-PET-11), aberta em aba nova pelo botão da ficha.
 *
 * Route handler, e não link direto ao backend: o `/v1` não tem endereço na internet, e o
 * token do Clerk só existe aqui no servidor. Mesmo desenho de `/dashboard/vacinas-atrasadas`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const file = await serverApi().downloadPetSheetPdf(id)
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `inline; filename="${file.filename}"`,
        // Alergia, alerta e, para quem pode, o telefone do tutor.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof ApiError) {
      return new NextResponse(error.message, {
        status: error.status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    throw error
  }
}
