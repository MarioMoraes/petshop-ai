import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-NOTIF, ligados ao catálogo do módulo.
 *
 * Valem só para `/v1/messages` e `/v1/messaging`. As duas rotas de webhook, sob
 * `/internal/`, não passam por aqui: quem autentica uma é o token da instância da
 * Evolution e a outra a assinatura Svix do Resend, sobre o corpo cru.
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })
