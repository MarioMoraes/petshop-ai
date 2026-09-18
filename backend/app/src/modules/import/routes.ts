import { ImportRequestSchema } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ActorContext } from './actor.js'
import { requirePermission, requireTenantContext } from './auth.js'
import { invalid } from './errors.js'
import * as service from './service.js'
import { parseInput } from './validate.js'

/**
 * As rotas do MOD-IMPORT, sob `/v1/import`.
 *
 * **Todas pedem o mesmo `import:run`** — inclusive a análise, que não grava nada, e o
 * histórico. A análise devolve a planilha do cliente remontada linha a linha e o
 * histórico diz quem carregou o quê: é o mesmo público nos três, e um `import:read`
 * separado só criaria um papel com meia migração na mão.
 *
 * **O arquivo é reenviado no `apply`**, em vez de ficar guardado entre os dois passos.
 * Guardá-lo criaria mais um lugar com a base inteira do cliente e um estado que expira
 * ("seu envio não está mais disponível", justamente depois de o operador conferir
 * quatrocentas linhas). O SHA-256 gravado no lote é o que prova que o que foi aplicado é
 * o que foi conferido.
 */

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  /** O catálogo de campos por passo — a tela monta o mapeamento e o modelo CSV daqui. */
  app.get(
    '/v1/import/entities',
    { preHandler: requirePermission('import:run') },
    async (request) => {
      requireTenantContext(request)
      return { items: service.entities() }
    },
  )

  /** Confere o arquivo e devolve o relatório linha a linha. **Não grava nada.** */
  app.post(
    '/v1/import/analyze',
    { preHandler: requirePermission('import:run') },
    async (request) => {
      const input = parseInput(ImportRequestSchema, request.body)
      return service.analyze(actorOf(request), input)
    },
  )

  app.post('/v1/import/apply', { preHandler: requirePermission('import:run') }, async (request) => {
    const input = parseInput(ImportRequestSchema, request.body)

    /**
     * Sem mapeamento confirmado não se aplica.
     *
     * O `analyze` aceita a sugestão do farejador para a tela ter o que mostrar; gravar
     * quatrocentas linhas por um palpite é justamente o erro que o passo de conferência
     * existe para evitar.
     */
    if (!input.mapping) throw invalid('Confirme o mapeamento das colunas antes de aplicar.')

    return service.apply(actorOf(request), input)
  })

  app.get(
    '/v1/import/batches',
    { preHandler: requirePermission('import:run') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { items: await service.listBatches(auth.tenantId) }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/v1/import/batches/:id',
    { preHandler: requirePermission('import:run') },
    async (request) => {
      const auth = requireTenantContext(request)
      return service.getBatch(auth.tenantId, request.params.id)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/import/batches/:id/undo',
    { preHandler: requirePermission('import:run') },
    async (request) => service.undo(actorOf(request), request.params.id),
  )
}
