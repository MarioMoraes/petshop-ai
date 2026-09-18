import 'server-only'
import {
  PublicPlanPricesSchema,
  catalogPlanPriceRows,
  type PlanPriceRow,
} from '@petshop/shared-types'

/**
 * O preço vigente dos planos, para as telas que mostram a tabela antes de haver
 * assinatura.
 *
 * **Por que não o catálogo do pacote.** Desde 2026-09-18 a equipe muda preço pelo console
 * (`/plataforma/planos`), e o número compilado no bundle é o do dia do deploy. Quem
 * escolhe plano — a etapa 2 do onboarding — precisa ver o que o checkout vai cobrar.
 *
 * **Por que a superfície pública e não `/v1`.** É a mesma tabela que a landing anuncia a
 * qualquer visitante, e a etapa 2 roda num momento em que a sessão pode não ter nem
 * permissão de financeiro nem estabelecimento pronto. `/public/v1/plans` não pede nada e
 * responde a mesma coisa.
 *
 * Falha de rede devolve o padrão do catálogo, nunca uma tela sem preço: preço velho é
 * pior que preço nenhum só quando ninguém avisa, e a etapa 2 não cobra — quem cobra é o
 * checkout, que lê a tabela no backend.
 */

const baseUrl = process.env.API_URL ?? 'http://localhost:3000'

export async function fetchPlanPrices(): Promise<PlanPriceRow[]> {
  try {
    // Cinco minutos, como `/api/planos`: preço muda raramente e a etapa 2 é uma tela de
    // leitura.
    const response = await fetch(`${baseUrl}/public/v1/plans`, { next: { revalidate: 300 } })
    if (!response.ok) throw new Error(`o gateway respondeu ${response.status}`)

    const { items } = PublicPlanPricesSchema.parse(await response.json())
    return items.length > 0 ? items : catalogPlanPriceRows()
  } catch (error) {
    console.warn(
      '[planos] não foi possível ler o preço vigente; a tela usa o padrão do catálogo',
      error instanceof Error ? error.message : error,
    )
    return catalogPlanPriceRows()
  }
}
