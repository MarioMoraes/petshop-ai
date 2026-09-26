import { NextResponse } from 'next/server'
import { ApiError } from '@petshop/api-client'
import { serverApi } from '@/lib/api'

/**
 * O PDF dos relatórios de cobrança, servido pelo Next.
 *
 * **Por que passar por aqui.** O browser nunca fala com o gateway (`lib/api.ts`): o
 * token do Clerk fica no servidor, e é isso que dispensa CORS e mantém o token fora do
 * JavaScript da página. Um `<a href>` apontando direto para o gateway chegaria lá sem
 * `Authorization` e voltaria 401. Esta rota é a ponte — ela tem a sessão, chama o
 * gateway e devolve os bytes.
 *
 * Não é uma Server Action porque o resultado é um **arquivo**: ação devolve dados para
 * a página, e transformar um PDF em base64 para o cliente remontar num `Blob` seria
 * atravessar 33% a mais de bytes para reimplementar o que `content-disposition` já faz.
 *
 * A rota é um segmento dinâmico com dois valores fixos, e não duas rotas: o que muda
 * entre elas é uma linha. A lista `RELATORIOS` é o que impede o segmento de virar
 * caminho arbitrário no gateway.
 */

const RELATORIOS = {
  'contas-a-receber': (query: URLSearchParams) =>
    serverApi().downloadAccountsReceivablePdf({
      ...(asDate(query.get('asOf')) ? { asOf: asDate(query.get('asOf')) as string } : {}),
      ...(asInt(query.get('minOverdueDays')) !== null
        ? { minOverdueDays: asInt(query.get('minOverdueDays')) as number }
        : {}),
    }),

  'recebidas-por-dia': (query: URLSearchParams) =>
    serverApi().downloadReceiptsByDayPdf({
      ...(asDate(query.get('from')) ? { from: asDate(query.get('from')) as string } : {}),
      ...(asDate(query.get('to')) ? { to: asDate(query.get('to')) as string } : {}),
    }),
} as const

type RelatorioKey = keyof typeof RELATORIOS

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relatorio: string }> },
) {
  const { relatorio } = await params
  if (!(relatorio in RELATORIOS)) {
    return new NextResponse('Relatório não encontrado', { status: 404 })
  }

  const query = new URL(request.url).searchParams

  try {
    const file = await RELATORIOS[relatorio as RelatorioKey](query)

    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        // O relatório é o retrato de um instante e leva o telefone de quem deve.
        // Nem o navegador nem nenhum intermediário tem por que guardar uma cópia.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    /*
     * O erro precisa **aparecer**, e o que o navegador está esperando aqui é um
     * arquivo — não uma página. Uma resposta de texto com o status certo é o que ele
     * consegue mostrar: o Gotenberg fora do ar vira 503 e a mensagem do serviço, em
     * vez de um download de zero byte que não explica nada.
     */
    if (error instanceof ApiError) {
      return new NextResponse(error.message, {
        status: error.status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    throw error
  }
}

function asDate(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function asInt(value: string | null): number | null {
  const parsed = Number(value)
  return value !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}
