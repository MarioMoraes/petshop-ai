import { AuditLogQuerySchema, SecurityEventQuerySchema } from '@petshop/shared-types'
import { createParseInput } from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from './auth.js'
import { validationError } from './errors.js'
import { listAuditLogs, listSecurityEvents, summarizeSecurityEvents } from './service.js'

/**
 * MOD-SEC — as duas leituras (§5 do PRD seguranca_compliance_13).
 *
 * **Só `GET`.** Nada aqui cria, altera ou apaga: a trilha é escrita por quem alterou
 * algo e o evento de segurança por uma recusa. Uma rota de escrita neste módulo seria a
 * porta pela qual a prova deixa de ser prova.
 *
 * As duas exigem `audit:read`, que na matriz do MOD-IDENT-04 só o `TENANT_ADMIN` tem.
 */

const parseInput = createParseInput(validationError)

export async function registerSecurityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/audit-logs',
    { preHandler: requirePermission('audit:read', 'Seu perfil não permite ler a trilha de auditoria') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(AuditLogQuerySchema, request.query)
      return listAuditLogs(auth.tenantId, query)
    },
  )

  app.get(
    '/v1/security-events',
    { preHandler: requirePermission('audit:read', 'Seu perfil não permite ler os eventos de segurança') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(SecurityEventQuerySchema, request.query)
      if (query.summary) return { items: await summarizeSecurityEvents(auth.tenantId, query) }
      return listSecurityEvents(auth.tenantId, query)
    },
  )
}
