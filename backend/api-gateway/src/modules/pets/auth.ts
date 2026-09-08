import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-PET, ligados ao catálogo do módulo.
 *
 * Valem para os três grupos de rota que o módulo registra — a ficha do pet, o catálogo
 * de espécie/raça/porte e o álbum de fotos —, porque os três respondem pelo mesmo
 * catálogo de erro (§5 do PRD).
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
