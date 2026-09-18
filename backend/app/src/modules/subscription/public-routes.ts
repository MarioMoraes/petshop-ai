import type { FastifyInstance } from 'fastify'
import { planPriceRows } from '../../shared/plan-prices.js'

/**
 * O preço dos planos, para quem ainda não é cliente.
 *
 * **Existe porque a landing é HTML estático noutro domínio** e não tem como ler o banco.
 * Sem ela, mudar o preço pelo console deixaria a página de vendas anunciando o preço
 * antigo — e a promessa quebrada apareceria no primeiro minuto de quem se cadastrasse.
 *
 * Fica na superfície `/public/v1`, fora do escopo autenticado, ao lado das rotas do site
 * do estabelecimento. Não há o que proteger: é a mesma tabela de preços que a página de
 * vendas exibe a qualquer visitante.
 *
 * **A borda não publica isto** (ver `infra/Caddyfile`, decisão 1: o gateway não tem porta
 * para a internet). Quem a chama é o servidor do Next, que a reexpõe em `/api/planos` com
 * o CORS da landing — abrir a API para o browser seria desfazer aquela decisão por causa
 * de três números.
 */

export async function registerPublicPlanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/public/v1/plans', async (_request, reply) => {
    // Dez minutos, o mesmo do site público: preço muda raramente, e a landing tem a
    // reserva no próprio HTML para o intervalo em que esta resposta estiver velha.
    return reply
      .header('cache-control', 'public, max-age=600')
      .send({ items: await planPriceRows() })
  })
}
