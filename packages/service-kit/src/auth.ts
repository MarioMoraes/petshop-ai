import type { AppError, PermissionKey, RoleKey } from '@petshop/shared-types'
import { withTenant, type TenantTransaction } from '@petshop/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuditEntry } from './audit.js'
import type { SecurityEventInput } from './security-events.js'

/**
 * Os guardas de autorização das rotas: tenant, tutor, escopo `_own` e permissão.
 *
 * O contexto chega pronto em `request.auth` — quem o resolve é o hook do processo, a
 * partir do token do Clerk (`backend/app/src/app.ts`). Até a fatia 11 da consolidação
 * ele chegava por headers assinados com HMAC (`@petshop/service-auth`), verificados na
 * porta de cada serviço; o pacote saiu com a última porta que o verificava.
 *
 * O contrato é o mesmo para todo módulo; o que muda entre eles é apenas para onde
 * apontam o catálogo de erro e a trilha de auditoria — daí os parâmetros.
 */

/** Quem está chamando, já resolvido: usuário, tenant, papel e permissões. */
export interface ServiceAuthContext {
  clerkUserId: string
  /** UUID local. Ausente antes do primeiro acesso, quando o espelho ainda não existe. */
  userId?: string
  /** Ausente quando o usuário ainda não tem tenant — é o caso de `POST /v1/tenants`. */
  tenantId?: string
  role?: RoleKey
  /**
   * A ficha de tutor deste usuário, quando a sessão é do Portal (MOD-PORTAL-02).
   *
   * Sem ele, `tutor:read_own` é indistinguível de `tutor:read` — a permissão diria
   * "só os próprios" sem que houvesse de quem. É o campo que dá sentido às nove
   * permissões `_own` que existem desde o MOD-IDENT-04 e nunca foram exigidas.
   *
   * Presente **somente** na sessão do Portal. Uma sessão de equipe nunca o carrega,
   * nem a de quem é funcionário e cliente do mesmo petshop: são duas sessões, com dois
   * escopos, e a do Portal não amplia por o usuário ter membership.
   */
  tutorId?: string
  permissions: PermissionKey[]
  permVersion?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: ServiceAuthContext
    /**
     * O recorte que uma permissão `_own` impõe à requisição.
     *
     * Escrito pelo `requirePermission` quando a permissão exigida termina em `_own`, e
     * lido pelo handler no lugar de `request.auth.tutorId`. A diferença não é
     * cosmética: o handler que lê daqui **não compila** sem ter passado pelo gate, e é
     * assim que RN-02 vira mecanismo em vez de disciplina.
     */
    ownScope?: OwnScope
  }
}

/** Contexto de um usuário que já tem tenant ativo. */
export interface TenantScopedAuth extends ServiceAuthContext {
  tenantId: string
}

/** Contexto de uma sessão do Portal: tem tenant **e** ficha de tutor. */
export interface TutorScopedAuth extends TenantScopedAuth {
  tutorId: string
}

/** O filtro que toda consulta sob escopo `_own` precisa carregar. */
export interface OwnScope {
  tutorId: string
}

/**
 * A permissão fala só dos próprios registros de quem a carrega?
 *
 * O sufixo é convenção da matriz do MOD-IDENT-04 (`packages/shared-types/src/
 * permissions.ts`), e é o que o gateway e os serviços usam para reconhecer uma sessão
 * de Portal sem precisar de uma segunda lista para manter em dia.
 */
export function isOwnPermission(permission: string): boolean {
  return permission.endsWith('_own')
}

export interface AuthContextConfig {
  forbidden: (detail: string) => AppError
  unauthorized: (detail?: string) => AppError
  recordAudit: (tx: TenantTransaction, entry: AuditEntry) => Promise<void>
  recordSecurityEvent: (input: SecurityEventInput) => Promise<void>
}

export interface ServiceAuth {
  requireTenantContext: (request: FastifyRequest) => TenantScopedAuth
  requireTutorContext: (request: FastifyRequest) => TutorScopedAuth
  requireOwnScope: (request: FastifyRequest) => OwnScope
  hasPermission: (request: FastifyRequest, permission: PermissionKey) => boolean
  requirePermission: (
    permission: PermissionKey,
    denialMessage?: string,
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
}

export function createAuthContext(config: AuthContextConfig): ServiceAuth {
  const { forbidden, unauthorized, recordAudit, recordSecurityEvent } = config

  function requireTenantContext(request: FastifyRequest): TenantScopedAuth {
    if (!request.auth?.tenantId) {
      throw forbidden('Selecione um estabelecimento para continuar')
    }
    return request.auth as TenantScopedAuth
  }

  /**
   * O contexto de uma sessão do Portal (MOD-PORTAL-02).
   *
   * Falha com **401**, e não 403: um vínculo revogado no meio da sessão (AC-05) não é
   * falta de permissão, é uma sessão que deixou de existir — e o cliente precisa saber
   * que tem de entrar de novo, não que lhe negaram algo.
   */
  function requireTutorContext(request: FastifyRequest): TutorScopedAuth {
    const auth = requireTenantContext(request)
    if (!auth.tutorId) {
      throw unauthorized('Seu acesso ao Portal não está mais ativo')
    }
    return auth as TutorScopedAuth
  }

  /**
   * O recorte que o gate `_own` deixou na requisição.
   *
   * Lançar aqui é falha de programação, não de autorização: significa que um handler
   * leu o escopo sem que a rota tivesse declarado a permissão `_own` que o produz.
   */
  function requireOwnScope(request: FastifyRequest): OwnScope {
    if (!request.ownScope) {
      throw forbidden('Esta operação exige escopo próprio')
    }
    return request.ownScope
  }

  function hasPermission(request: FastifyRequest, permission: PermissionKey): boolean {
    return request.auth?.permissions?.includes(permission) ?? false
  }

  return {
    requireTenantContext,
    requireTutorContext,
    requireOwnScope,
    hasPermission,

    /**
     * `preHandler` que exige uma permissão da matriz (PRDs §9).
     *
     * A negação vira o 403 do catálogo do serviço e é registrada em `audit_logs` com
     * `outcome = DENIED`, além de virar evento de segurança para a métrica
     * `auth_permission_denied_total`.
     *
     * **Permissão terminada em `_own` faz mais do que autorizar** (RN-02 do MOD-PORTAL):
     * ela exige o `tutorId` do contexto da sessão e deixa o recorte em `request.ownScope`,
     * de onde o handler o lê. Ter a permissão e não ter a ficha não é acesso amplo — é
     * sessão inválida, e responde 401.
     */
    requirePermission(permission: PermissionKey, denialMessage?: string) {
      return async function checkPermission(request: FastifyRequest, _reply: FastifyReply) {
        const auth = requireTenantContext(request)
        if (hasPermission(request, permission)) {
          if (isOwnPermission(permission)) {
            request.ownScope = { tutorId: requireTutorContext(request).tutorId }
          }
          return
        }

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
