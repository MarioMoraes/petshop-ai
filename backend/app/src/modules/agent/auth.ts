import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-AI, ligados ao catálogo do módulo.
 *
 * Valem para `/v1/agent`, que é superfície da **equipe**. A entrada do cliente não passa
 * por aqui: ela chega pelo webhook da Evolution, sob `/internal/`, autenticada pelo token
 * da instância — e nenhuma sessão do produto existe do outro lado.
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
