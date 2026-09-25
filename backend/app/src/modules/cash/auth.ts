import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/** Os guardas do MOD-CAIXA, com o catálogo do módulo (`ERR_CASH_007` na negação). */
export const { requireTenantContext, requirePermission, hasPermission } = createModuleAuth({
  forbidden,
  unauthorized,
})
