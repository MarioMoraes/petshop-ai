import { createAuthContext } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { recordAudit } from '../lib/audit.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { recordSecurityEvent } from '../lib/security-events.js'

/**
 * Autenticação de serviço do site: o contrato HMAC gateway→serviço vem do
 * `@petshop/service-kit`; o que se liga aqui é o catálogo de erro e a trilha de
 * auditoria deste serviço. A negação de permissão vira 403 `ERR_SITE_008` (§9).
 *
 * Vale só para `/v1/site/*`. A superfície `/public/v1/*` não passa por aqui — ela é
 * anônima por definição, e o `registerAuthContext` do kit ignora caminhos fora de
 * `/v1` (é o mesmo hook que deixa `/health` passar).
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
