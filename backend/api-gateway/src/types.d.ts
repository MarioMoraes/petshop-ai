import type { ServiceAuthContext } from '@petshop/service-auth'
import type { MfaState } from '@petshop/shared-types'

/**
 * Contexto resolvido pelo gateway, disponível a partir do hook `onRequest`.
 * Opcional no tipo porque rotas públicas (`/health`, `/ready`) não passam pelo hook.
 */
declare module 'fastify' {
  interface FastifyRequest {
    authContext: ServiceAuthContext
    /**
     * O estado de segundo fator desta sessão (MOD-SEC-02).
     *
     * Só a sessão da equipe o carrega: a do Portal e a porta interna não passam por
     * `resolveSession`, e o tutor não tem papel administrativo a exigir. Quem o lê é
     * `GET /v1/me`, para decidir entre a faixa de aviso e a tela de bloqueio.
     */
    mfa?: MfaState
  }
}
