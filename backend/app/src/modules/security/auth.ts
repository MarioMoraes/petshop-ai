import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/** Os guardas do MOD-SEC, ligados ao catálogo do módulo (§5 do PRD). */
export const { requireTenantContext, hasPermission, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})
