import { afterAll, describe, expect, it } from 'vitest'
import { closeHarness, getApp, registeredPaths } from './harness.js'

/**
 * O inventário do que responde sem token.
 *
 * A autenticação é um hook por **caminho** (`app.ts`): `/health`, `/ready`, `/public/`,
 * `/internal/` e a identidade visual do Portal passam sem sessão. Rota nova debaixo de um
 * desses prefixos nasce anônima, e nada no registro dela diz isso — é o "nasce aberta"
 * do CLAUDE.md. Aqui toda rota registrada é chamada sem token, e o conjunto do que **não**
 * responde 401 precisa ser exatamente a lista abaixo.
 *
 * Rota que entra na lista é decisão: quem a escreve diz, no próprio handler, como ela se
 * autentica sozinha (assinatura do provedor, token por tenant) ou por que é pública.
 */
const ANONIMAS = new Set([
  '/health',
  '/ready',
  // Webhooks: cada um se autentica sozinho, com assinatura ou token do provedor.
  '/internal/v1/asaas/tutor-webhook',
  '/internal/v1/asaas/webhook',
  '/internal/v1/clerk/webhook',
  '/internal/v1/email/webhook',
  '/internal/v1/whatsapp/webhook',
  // A cor e o nome do petshop na tela de login do Portal, antes de haver sessão.
  '/portal/v1/tenant',
  // A landing, o catálogo de petshops do app e o site do petshop.
  '/public/v1/plans',
  '/public/v1/portal/tenants',
  '/public/v1/site',
  '/public/v1/site/leads',
  '/public/v1/site/photos/:id',
])

const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Um valor qualquer no lugar de cada parâmetro: o hook decide antes do roteador. */
function concreto(caminho: string): string {
  return caminho
    .replace(/:[A-Za-z0-9_]+/g, '00000000-0000-4000-8000-000000000000')
    .replace(/\*/g, 'x')
}

afterAll(closeHarness)

describe('rotas que respondem sem token', () => {
  it('são exatamente as da lista', async () => {
    const app = await getApp()
    // A árvore impressa traz também os nós de prefixo (`/public/v1/`), que não são rota.
    const caminhos = [...new Set(registeredPaths(app))].filter((caminho) =>
      METODOS.some((method) => app.hasRoute({ method, url: caminho })),
    )
    expect(caminhos.length).toBeGreaterThan(100)

    const abertas: string[] = []
    for (const caminho of caminhos) {
      const resposta = await app.inject({
        method: 'GET',
        url: concreto(caminho),
        // Slug de um petshop que não existe: sem ele o Portal recusaria antes de olhar o
        // token, e a recusa não diria nada sobre a autenticação.
        headers: { 'x-petshop-tenant-slug': 'nao-existe' },
      })
      if (resposta.statusCode !== 401) abertas.push(caminho)
    }

    expect(abertas.sort()).toEqual([...ANONIMAS].sort())
  })
})
