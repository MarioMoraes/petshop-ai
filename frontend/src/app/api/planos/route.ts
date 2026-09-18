import { NextResponse } from 'next/server'
import { PublicPlanPricesSchema } from '@petshop/shared-types'

/**
 * O preço dos planos, para a landing page.
 *
 * **Por que o Next e não o backend direto.** A landing é HTML estático servido por um
 * nginx próprio em outro domínio (`infra/docker-compose.landing.yml`), e a borda do
 * produto **não publica o gateway** — decisão 1 do `infra/Caddyfile`, que apaga a
 * superfície pública da API inteira. Abrir uma rota da API ao browser por causa de três
 * números desfaria aquela decisão; o Next já é publicado, já fala com o gateway pela rede
 * interna, e é aqui que a permissão de origem cruzada fica sob nossa vista.
 *
 * **`*` na origem é deliberado.** O corpo é a tabela de preços que qualquer visitante lê
 * na página de vendas, não há cookie nem token nesta chamada, e uma lista de origens em
 * variável de ambiente que ninguém preencheu na VPS quebraria a landing em silêncio — o
 * preço de errar para o lado restritivo é maior do que o de não restringir nada.
 *
 * Se esta resposta falhar, a landing fica com o preço do próprio HTML. É por isso que ela
 * pode falhar sem consequência, e por isso que o erro devolve 200 com a lista vazia em vez
 * de um status que o `fetch` da página teria de tratar.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'cache-control': 'public, max-age=300, s-maxage=300',
}

const baseUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

export async function GET() {
  try {
    const response = await fetch(`${baseUrl}/public/v1/plans`, {
      // Cinco minutos, o mesmo do cache do backend: preço muda raramente, e a landing
      // tem a reserva no HTML para o intervalo em que esta resposta estiver velha.
      next: { revalidate: 300 },
    })
    if (!response.ok) throw new Error(`gateway respondeu ${response.status}`)

    const parsed = PublicPlanPricesSchema.parse(await response.json())
    return NextResponse.json(parsed, { headers: CORS })
  } catch (error) {
    console.warn(
      '[planos] não foi possível ler o preço dos planos; a landing usa a reserva do HTML',
      error instanceof Error ? error.message : error,
    )
    return NextResponse.json({ items: [] }, { headers: CORS })
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}
