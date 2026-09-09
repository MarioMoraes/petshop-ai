import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do site, ligados ao catálogo do módulo.
 *
 * O que muda em relação ao host é só isso: a negação de permissão vira 403
 * `ERR_SITE_008` (§9 do PRD), e não o 403 genérico de identidade. O mecanismo — a
 * matriz de papéis, a trilha de auditoria com `outcome = DENIED` e o evento de
 * segurança — é o mesmo do `@petshop/service-kit`.
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
