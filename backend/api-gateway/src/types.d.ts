import type { ServiceAuthContext } from '@petshop/service-auth'

/**
 * Contexto resolvido pelo gateway, disponível a partir do hook `onRequest`.
 * Opcional no tipo porque rotas públicas (`/health`, `/ready`) não passam pelo hook.
 */
declare module 'fastify' {
  interface FastifyRequest {
    authContext: ServiceAuthContext
  }
}
