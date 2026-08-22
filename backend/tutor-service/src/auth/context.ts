import { verifyServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import type { PermissionKey } from '@petshop/shared-types'
import { withTenant } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { loadEnv } from '../env.js'
import { recordAudit } from '../lib/audit.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { recordSecurityEvent } from '../lib/security-events.js'

/**
 * Autenticação do serviço: confere a assinatura do gateway e expõe o contexto.
 *
 * Idêntico ao do identity-service por construção — o contrato HMAC gateway→serviço é
 * o mesmo para todo serviço. Fica duplicado, e não em um pacote, porque cada serviço
 * traz o próprio catálogo de erro e a própria trilha de auditoria; extrair só a
 * verificação renderia um pacote de três linhas.
 *
 * O serviço nunca vê o JWT do Clerk — quem valida token é o gateway. O que chega aqui
 * é o resultado já resolvido (usuário, tenant, permissões), assinado com HMAC. Sem
 * assinatura válida, a requisição não passa: alcançar a porta do serviço direto,
 * pulando o gateway, não deve valer nada.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auth: ServiceAuthContext
  }
}

/** Rotas que não exigem autenticação de serviço. */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/docs', '/docs/json'])

export function registerAuthContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return

    const result = verifyServiceHeaders(request.headers, loadEnv().INTERNAL_SERVICE_SECRET)
    if (!result.ok) {
      request.log.warn({ reason: result.reason, path: request.url }, 'assinatura de serviço inválida')
      throw unauthorized('Requisição não autenticada')
    }
    request.auth = result.context
  })
}

/** Contexto de um usuário que já tem tenant ativo. */
export interface TenantScopedAuth extends ServiceAuthContext {
  tenantId: string
}

export function requireTenantContext(request: FastifyRequest): TenantScopedAuth {
  if (!request.auth?.tenantId) {
    throw forbidden('Selecione um estabelecimento para continuar')
  }
  return request.auth as TenantScopedAuth
}

export function hasPermission(request: FastifyRequest, permission: PermissionKey): boolean {
  return request.auth?.permissions?.includes(permission) ?? false
}

/**
 * `preHandler` que exige uma permissão da matriz (PRD tutores_02 §9).
 *
 * A negação vira 403 `ERR_TUTOR_003` e é registrada em `audit_logs` com
 * `outcome = DENIED`, além de virar evento de segurança para a métrica
 * `auth_permission_denied_total`.
 */
export function requirePermission(permission: PermissionKey, denialMessage?: string) {
  return async function checkPermission(request: FastifyRequest, _reply: FastifyReply) {
    const auth = requireTenantContext(request)
    if (hasPermission(request, permission)) return

    const detail = denialMessage ?? 'Seu perfil não permite esta operação'

    await withTenant(auth.tenantId, (tx) =>
      recordAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? null,
        action: 'auth.permission_denied',
        entity: 'permission',
        entityId: permission,
        outcome: 'DENIED',
        after: { permission, role: auth.role, path: request.url, method: request.method },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      }),
    ).catch((error: unknown) => {
      request.log.error({ err: error }, 'falha ao auditar negação de permissão')
    })

    await recordSecurityEvent({
      tenantId: auth.tenantId,
      type: 'PERMISSION_DENIED',
      actorUserId: auth.userId ?? null,
      targetEntity: 'permission',
      targetId: permission,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      metadata: { path: request.url, method: request.method, role: auth.role },
    })

    throw forbidden(detail)
  }
}
