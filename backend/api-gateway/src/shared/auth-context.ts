import { createAuthContext, type ServiceAuth } from '@petshop/service-kit'
import type { AppError } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { loadEnv } from '../config/env.js'
import { recordAudit } from './audit.js'
import { unauthorized } from './errors.js'
import { recordSecurityEvent } from './security-events.js'

/**
 * Os guardas de autorização dos módulos, e a ponte que substitui o salto entre
 * processos.
 *
 * `requireTenantContext`, `requirePermission` e o escopo `_own` vêm do
 * `@petshop/service-kit` e continuam idênticos ao que os serviços usavam — o que muda
 * é só **de onde o contexto chega**. Antes vinha de headers assinados com HMAC,
 * verificados na porta de cada serviço; agora o hook do gateway já o resolveu do token
 * do Clerk, no mesmo processo, e o que resta é apresentá-lo sob o nome que o kit lê.
 *
 * `request.authContext` e `request.auth` são o mesmo `ServiceAuthContext`. A cópia é a
 * consolidação inteira, do ponto de vista da autorização.
 */

/**
 * Os guardas de **um** módulo.
 *
 * É uma fábrica, e não um objeto pronto, por causa do catálogo de erro: a negação de
 * permissão numa rota do site é `ERR_SITE_008` (§9 do PRD), não o 403 genérico do
 * host. Um conjunto de guardas para o processo inteiro faria todo módulo responder com
 * o código do gateway — e o frontend, que decide o que mostrar pelo código, passaria a
 * ver um erro de identidade onde o contrato promete um erro do site.
 */
export function createModuleAuth(catalog: {
  forbidden: (detail: string) => AppError
  unauthorized: (detail?: string) => AppError
}): ServiceAuth {
  return createAuthContext({
    getSecret: () => loadEnv().INTERNAL_SERVICE_SECRET,
    forbidden: catalog.forbidden,
    unauthorized: catalog.unauthorized,
    recordAudit,
    recordSecurityEvent,
  })
}

/**
 * Registra o contexto resolvido para as rotas de um escopo do Fastify.
 *
 * **É o hook que separa superfície autenticada de superfície pública**, e o lugar
 * exato onde a consolidação pode errar feio: uma rota administrativa registrada fora
 * deste escopo nasce sem autenticação nenhuma. Ele fica no escopo, e não no app, pela
 * mesma razão que o `registerAuthContext` do kit ficava — para que a rota pública seja
 * a exceção declarada, e não o esquecimento.
 */
export function registerModuleAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!request.authContext) throw unauthorized('Requisição não autenticada')
    request.auth = request.authContext
  })
}

export type { TenantScopedAuth } from '@petshop/service-kit'
