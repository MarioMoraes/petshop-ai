import { ApproveSupportAccessSchema } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission, requireTenantContext } from '../identity/auth.js'
import {
  approveSupportAccess,
  denySupportAccess,
  listSupportAccess,
  revokeSupportAccess,
} from './grants.js'
import { parseInput } from './validate.js'

/**
 * O outro lado do grant: as rotas do **estabelecimento** (MOD-ADMIN-02).
 *
 * **Moram em `/v1`, e não em `/platform/v1`**, porque quem as chama é o administrador do
 * petshop, na tela dele. É a mesma fronteira que separa `/portal/v1` do Admin: o prefixo
 * diz de quem é a superfície, não de que assunto ela trata.
 *
 * Exigem `tenant:configure` — a mesma permissão que governa as configurações do
 * estabelecimento. Autorizar alguém de fora a ler a base é decisão de quem administra a
 * conta, não de quem opera o balcão.
 */

const IdParamSchema = z.object({ id: z.uuid() })

function actorOf(request: FastifyRequest) {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

const CONFIGURE = {
  preHandler: requirePermission(
    'tenant:configure',
    'Somente quem administra a conta autoriza acesso do suporte',
  ),
}

export async function registerSupportAccessRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A leitura é mais larga que a escrita de propósito: `tenant:read_settings`.
   *
   * Quem opera o balcão não aprova acesso, mas precisa **ver** que alguém de fora está
   * lendo a base — o histórico é a metade do valor do mecanismo, e escondê-lo de quem
   * trabalha ali seria manter o consentimento como formalidade.
   */
  app.get(
    '/v1/support-access',
    { preHandler: requirePermission('tenant:read_settings') },
    async (request) => ({ items: await listSupportAccess(requireTenantContext(request).tenantId) }),
  )

  app.post('/v1/support-access/:id/approve', CONFIGURE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(ApproveSupportAccessSchema, request.body ?? {})
    return approveSupportAccess(actorOf(request), id, input.hours)
  })

  app.post('/v1/support-access/:id/deny', CONFIGURE, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await denySupportAccess(actorOf(request), id)
    return reply.status(204).send()
  })

  app.post('/v1/support-access/:id/revoke', CONFIGURE, async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await revokeSupportAccess(actorOf(request), id)
    return reply.status(204).send()
  })
}
