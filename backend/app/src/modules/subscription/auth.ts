import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/** Os guardas da assinatura, com o catálogo do módulo (`ERR_SUB_002` na negação). */
export const { requireTenantContext, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})
