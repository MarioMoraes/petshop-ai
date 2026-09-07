import { NextResponse } from 'next/server'
import { ApiError } from '@petshop/api-client'
import { serverApi } from '@/lib/api'

/**
 * O extrato da conta do tutor em PDF (AC-01 de MOD-DOC-09).
 *
 * **Por que passar por aqui.** O browser nunca fala com o gateway (`lib/api.ts`): o token
 * do Clerk fica no servidor, e um `<a href>` apontando direto para lá chegaria sem
 * `Authorization` e voltaria 401. Esta rota é a ponte, como a dos relatórios de cobrança.
 *
 * Não é uma Server Action porque o resultado é um **arquivo**: ação devolve dados para a
 * página, e transformar um PDF em base64 para o cliente remontar num `Blob` seria
 * atravessar 33% a mais de bytes para reimplementar o que `content-disposition` já faz.
 *
 * O intervalo vem da própria tela do extrato, que já tem os dois campos de data: o papel
 * sai do mesmo recorte que está na tela, e não de um período que só o PDF conhece.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const query = new URL(request.url).searchParams

  try {
    const file = await serverApi().downloadStatementPdf(id, {
      ...(asDate(query.get('from')) ? { from: asDate(query.get('from')) as string } : {}),
      ...(asDate(query.get('to')) ? { to: asDate(query.get('to')) as string } : {}),
    })

    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        // O extrato é a conta corrente de uma pessoa: nem o navegador nem nenhum
        // intermediário tem por que guardar uma cópia.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // A folha é um anexo: devolver um JSON de erro abriria uma aba com problem+json na
    // cara de quem clicou. O texto curto é o que dá para ler numa aba em branco.
    const mensagem =
      error instanceof ApiError
        ? error.message
        : 'Não foi possível gerar o extrato agora. Tente novamente em instantes.'

    return new NextResponse(mensagem, {
      status: error instanceof ApiError ? error.status : 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

/** `YYYY-MM-DD` ou nada: o que não é data não vira parâmetro de consulta no gateway. */
function asDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}
