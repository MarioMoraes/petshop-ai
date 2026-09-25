import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/** Os guardas do MOD-ESTOQUE, com o catálogo do módulo (`ERR_INV_009` na negação). */
export const { requireTenantContext, requirePermission, hasPermission } = createModuleAuth({
  forbidden,
  unauthorized,
})
