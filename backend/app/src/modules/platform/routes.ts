import { hashEmail } from '@petshop/db'
import { GrantPlatformAdminSchema, RequestSupportAccessSchema } from '@petshop/shared-types'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { notFound } from './errors.js'
import { requestSupportAccess } from './grants.js'
import {
  grantPlatformAdmin,
  listPlatformAdmins,
  revokePlatformAdmin,
} from './service.js'
import { parseInput } from './validate.js'

const IdParamSchema = z.object({ id: z.uuid() })
const TenantParamSchema = z.object({ tenantId: z.uuid() })

/**
 * As rotas da plataforma (PRD observabilidade_admin_14 §5).
 *
 * **O prefixo `/platform/v1` tem resolução de sessão própria**, e é a mesma razão pela
 * qual `/portal/v1` tem a dele: o contexto não sai de um `membership`. Quem chega aqui
 * apresenta token **sem Organization** e tem linha viva em `platform_admins` — as duas
 * coisas, e o `app.ts` as confere antes do roteamento.
 *
 * **Nenhuma destas rotas toca dado de negócio de tenant.** Elas administram o próprio
 * papel de plataforma. O acesso ao dado do estabelecimento é o MOD-ADMIN-02, e depende de
 * autorização com prazo.
 */

/** Quem está agindo, para a trilha da plataforma. */
function actorOf(request: FastifyRequest) {
  const context = request.authContext
  if (!context?.userId) throw notFound()
  return {
    userId: context.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export const PLATFORM_PREFIX = '/platform/v1'

/**
 * A pergunta que o `app.ts` faz antes de resolver a sessão.
 *
 * Mora aqui, e não no host, pela mesma razão que `isPortalPath` mora em
 * `modules/portal/routes.ts`: quem sabe qual é o espaço de rotas de um módulo é o módulo.
 */
export function isPlatformPath(path: string): boolean {
  return path === PLATFORM_PREFIX || path.startsWith(`${PLATFORM_PREFIX}/`)
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A lista existe para que a concessão não seja cega: conceder sem ver quem já tem é
   * como o segundo administrador vira o quarto sem ninguém notar.
   */
  app.get('/platform/v1/admins', async () => ({ items: await listPlatformAdmins() }))

  app.post('/platform/v1/admins', async (request, reply) => {
    const input = parseInput(GrantPlatformAdminSchema, request.body)
    /**
     * A busca é por **hash**, nunca pelo texto do e-mail: `users.email_encrypted` é
     * cifrado e `email_hash` é o índice de busca do produto inteiro. Um `LIKE` sobre a
     * coluna cifrada não acharia ninguém, e decifrar a base para comparar seria pior.
     */
    const created = await grantPlatformAdmin(actorOf(request), hashEmail(input.email))
    return reply.status(201).send(created)
  })

  app.delete('/platform/v1/admins/:id', async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await revokePlatformAdmin(actorOf(request), id)
    return reply.status(204).send()
  })

  /**
   * O pedido de acesso a um estabelecimento (MOD-ADMIN-02, AC-01).
   *
   * Só pedir: nada é lido aqui. Quem concede é o administrador do petshop, em
   * `POST /v1/support-access/:id/approve`, e é ele quem define o prazo.
   */
  app.post('/platform/v1/tenants/:tenantId/support-access', async (request, reply) => {
    const { tenantId } = parseInput(TenantParamSchema, request.params)
    const input = parseInput(RequestSupportAccessSchema, request.body)
    const actor = actorOf(request)

    const created = await requestSupportAccess(actor, tenantId, input.reason)
    return reply.status(201).send(created)
  })
}
