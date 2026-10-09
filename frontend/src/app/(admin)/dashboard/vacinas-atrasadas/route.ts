import { NextResponse } from 'next/server'
import { ApiError } from '@petshop/api-client'
import { serverApi } from '@/lib/api'

/**
 * A lista de pets com vacina atrasada, em PDF — o que o cartão do Início abre.
 *
 * A ponte de `estoque/posicao/pdf/route.ts`, pelas mesmas razões: o browser nunca fala
 * com o gateway, e o resultado é um arquivo, e não dados para a página. Sai `inline`, e
 * não `attachment`: o cartão abre a folha numa aba, e quem quiser a guarda dali.
 */
export async function GET() {
  try {
    const file = await serverApi().downloadOverdueVaccinesPdf()
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `inline; filename="${file.filename}"`,
        // Nome e telefone de tutor.
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
