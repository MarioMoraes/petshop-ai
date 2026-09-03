import { createAuthContext } from '@petshop/service-kit'
import { loadEnv } from '../env.js'
import { recordAudit } from '../lib/audit.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { recordSecurityEvent } from '../lib/security-events.js'

/**
 * Autenticação de serviço do Portal: o contrato HMAC gateway→serviço vem do
 * `@petshop/service-kit`; o que se liga aqui é o catálogo de erro e a trilha deste
 * serviço.
 *
 * `requireTutorContext` é a peça nova do MOD-PORTAL-02 e o gate real de quase toda rota
 * daqui: sem `tutorId` no contexto assinado, a sessão do Clerk é válida mas não
 * corresponde a ficha nenhuma neste petshop — 401, e não 403, porque não é falta de
 * permissão, é uma sessão que não representa cliente algum.
 */

export const {
  registerAuthContext,
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createAuthContext({
  getSecret: () => loadEnv().INTERNAL_SERVICE_SECRET,
  forbidden,
  unauthorized,
  recordAudit,
  recordSecurityEvent,
})

export type { TenantScopedAuth, TutorScopedAuth } from '@petshop/service-kit'
