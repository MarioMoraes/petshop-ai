import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-TUTOR, ligados ao catálogo do módulo.
 *
 * Valem para os cinco grupos de rota que vieram com ele — a ficha, os endereços, as
 * tags, os consentimentos e os termos —, porque os cinco respondem pelo mesmo catálogo
 * de erro (§5 do PRD tutores_02).
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
