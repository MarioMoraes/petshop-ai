import { verifyServiceHeaders, type ServiceAuthContext } from '@petshop/service-auth'
import type { AppError, PermissionKey } from '@petshop/shared-types'
import { withTenant, type TenantTransaction } from '@petshop/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditEntry } from './audit.js'
import type { SecurityEventInput } from './security-events.js'

/**
 * Autenticação de serviço: confere a assinatura do gateway e expõe o contexto.
 *
 * O serviço nunca vê o JWT do Clerk — quem valida token é o gateway. O que chega aqui
 * é o resultado já resolvido (usuário, tenant, permissões), assinado com HMAC. Sem
 * assinatura válida a requisição não passa: alcançar a porta do serviço direto,
 * pulando o gateway, não deve valer nada.
 *
 * O contrato é o mesmo para todo serviço; o que muda entre eles é apenas para onde
 * apontam o catálogo de erro e a trilha de auditoria — daí os parâmetros.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auth: ServiceAuthContext
  }
}

/** Contexto de um usuário que já tem tenant ativo. */
export interface TenantScopedAuth extends ServiceAuthContext {
  tenantId: string
}

/** Rotas que não exigem autenticação de serviço. */
export const DEFAULT_PUBLIC_PATHS = ['/health', '/ready', '/docs', '/docs/json'] as const

export interface AuthContextConfig {
  /** Lido a cada requisição: `loadEnv()` é memoizado sob demanda e resetado em teste. */
  getSecret: () => string
  forbidden: (detail: string) => AppError
  unauthorized: (detail?: string) => AppError
  recordAudit: (tx: TenantTransaction, entry: AuditEntry) => Promise<void>
  recordSecurityEvent: (input: SecurityEventInput) => Promise<void>
  /** Substitui — não acrescenta — a lista padrão, para o serviço que precisar. */
  publicPaths?: readonly string[]
}

export interface ServiceAuth {
  registerAuthContext: (app: FastifyInstance) => void
  requireTenantContext: (request: FastifyRequest) => TenantScopedAuth
  hasPermission: (request: FastifyRequest, permission: PermissionKey) => boolean
  requirePermission: (
    permission: PermissionKey,
    denialMessage?: string,
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
}

export function createAuthContext(config: AuthContextConfig): ServiceAuth {
  const { forbidden, unauthorized, recordAudit, recordSecurityEvent } = config
  const publicPaths = new Set<string>(config.publicPaths ?? DEFAULT_PUBLIC_PATHS)

  function requireTenantContext(request: FastifyRequest): TenantScopedAuth {
    if (!request.auth?.tenantId) {
      throw forbidden('Selecione um estabelecimento para continuar')
    }
    return request.auth as TenantScopedAuth
  }

  function hasPermission(request: FastifyRequest, permission: PermissionKey): boolean {
    return request.auth?.permissions?.includes(permission) ?? false
  }

  return {
    registerAuthContext(app: FastifyInstance): void {
      app.addHook('onRequest', async (request: FastifyRequest) => {
        if (publicPaths.has(request.url.split('?')[0] ?? '')) return

        const result = verifyServiceHeaders(request.headers, config.getSecret())
        if (!result.ok) {
          request.log.warn(
            { reason: result.reason, path: request.url },
            'assinatura de serviço inválida',
          )
          throw unauthorized('Requisição não autenticada')
        }
        request.auth = result.context
      })
    },

    requireTenantContext,
    hasPermission,

    /**
     * `preHandler` que exige uma permissão da matriz (PRDs §9).
     *
     * A negação vira o 403 do catálogo do serviço e é registrada em `audit_logs` com
     * `outcome = DENIED`, além de virar evento de segurança para a métrica
     * `auth_permission_denied_total`.
     */
    requirePermission(permission: PermissionKey, denialMessage?: string) {
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
    },
  }
}
