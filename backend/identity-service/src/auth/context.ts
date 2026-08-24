import { createAuthContext } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { recordAudit } from '../lib/audit.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { recordSecurityEvent } from '../lib/security-events.js'

/**
 * Autenticação de serviço do identity-service: o contrato HMAC gateway→serviço vem do
 * `@petshop/service-kit`; o que se liga aqui é o catálogo de erro e a trilha de
 * auditoria deste serviço. AC-02 de MOD-IDENT-04: a negação vira 403 `ERR_IDENT_003`
 * e fica registrada em `audit_logs` com `outcome = DENIED`.
 */

export const { registerAuthContext, requireTenantContext, hasPermission, requirePermission } =
  createAuthContext({
    getSecret: () => loadEnv().INTERNAL_SERVICE_SECRET,
    forbidden,
    unauthorized,
    recordAudit,
    recordSecurityEvent,
  })

export type { TenantScopedAuth } from '@petshop/service-kit'
