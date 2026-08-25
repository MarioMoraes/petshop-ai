import { createAuthContext } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { recordAudit } from '../lib/audit.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { recordSecurityEvent } from '../lib/security-events.js'

/**
 * Autenticação de serviço do financeiro: o contrato HMAC gateway→serviço vem do
 * `@petshop/service-kit`; o que se liga aqui é o catálogo de erro e a trilha deste
 * serviço. A negação vira 403 `ERR_LEDGER_010` (§5).
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
