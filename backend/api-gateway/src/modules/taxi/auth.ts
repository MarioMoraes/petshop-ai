import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do Taxi Dog, ligados ao catálogo do módulo.
 *
 * O peso aqui é o do motorista: `taxi:operate` no papel DRIVER vale só para as
 * **próprias** corridas (RN-19), e a negação registra evento de segurança — a
 * tentativa de mexer na corrida de um colega é exatamente o que esse registro existe
 * para expor.
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
