import 'server-only'
import { auth } from '@clerk/nextjs/server'
import { createApiClient, type ApiClient } from '@petshop/api-client'

/**
 * Cliente do gateway para uso no servidor.
 *
 * O token do Clerk fica no servidor: o browser nunca fala com o gateway direto.
 * Assim não há CORS a afrouxar nem token exposto ao JavaScript da página.
 */

const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

export function serverApi(): ApiClient {
  return createApiClient({
    baseUrl,
    getToken: async () => {
      const session = await auth()
      // O template nomeado publica o claim `permVersion` que o gateway compara
      // (ver docs/setup-clerk.md). Sem ele, cai no token de sessão padrão.
      return (await session.getToken({ template: 'petshop' }).catch(() => null)) ?? session.getToken()
    },
  })
}
