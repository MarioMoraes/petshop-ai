import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do CRM, ligados ao catálogo do módulo.
 *
 * O módulo é o que decide **quem** recebe mensagem; a negação de permissão aqui vira o
 * 403 do catálogo do CRM (§9), e não o genérico do host.
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
