import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-LEDGER, ligados ao catálogo do módulo. A negação
 * vira 403 `ERR_LEDGER_010` (§5).
 *
 * Aqui o recorte do §9 vale mais que na média: `finance:refund`, `finance:credit` e
 * `finance:configure` são exatamente o que separa a recepção do gestor. O balcão
 * registra o pagamento; quem estorna é quem responde pelo caixa (RN-25).
 */

export const { requireTenantContext, hasPermission, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})

export type { TenantScopedAuth } from '@petshop/service-kit'
