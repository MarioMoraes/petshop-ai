import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-IDENT, ligados ao catálogo do módulo.
 *
 * AC-02 de MOD-IDENT-04: a negação vira 403 `ERR_IDENT_003` e fica registrada em
 * `audit_logs` com `outcome = DENIED`, mais o `SecurityEvent` correspondente. O que
 * mudou com a consolidação é só de onde o contexto chega — antes de headers assinados
 * na porta do serviço, agora do token que o hook do gateway já resolveu.
 */

export const { requireTenantContext, hasPermission, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})

export type { TenantScopedAuth } from '@petshop/service-kit'
