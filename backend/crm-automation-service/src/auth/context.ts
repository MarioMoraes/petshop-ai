import { createAuthContext } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { recordAudit } from '../lib/audit.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { recordSecurityEvent } from '../lib/security-events.js'

/** Contrato HMAC gateway→serviço, com o catálogo de erro deste módulo. */

export const { registerAuthContext, requireTenantContext, hasPermission, requirePermission } =
  createAuthContext({
    getSecret: () => loadEnv().INTERNAL_SERVICE_SECRET,
    forbidden,
    unauthorized,
    recordAudit,
    recordSecurityEvent,
  })

export type { TenantScopedAuth } from '@petshop/service-kit'
