import type { FastifyInstance } from 'fastify'
import { registerInvitationRoutes } from './invitations/routes.js'
import { registerMeRoutes } from './me/routes.js'
import { registerOnboardingRoutes } from './onboarding/routes.js'
import { registerRbacRoutes } from './rbac/routes.js'
import { registerSettingsRoutes } from './settings/routes.js'
import { registerTenantRoutes } from './tenants/routes.js'

/**
 * MOD-IDENT — o tenant, o wizard, a matriz de papéis, os convites e o `GET /v1/me`.
 *
 * **Nenhuma rota deste módulo exige tenant no hook**, e isso é da natureza dele: três
 * caminhos existem justamente para quem ainda não é membro de lugar nenhum — criar o
 * primeiro estabelecimento (`POST /v1/tenants`), espiar um convite e aceitá-lo. Quem
 * exige contexto de tenant é cada rota, com `requireTenantContext`, e não a montagem.
 *
 * A ordem de registro importa numa única passagem: `/v1/tenants/slug-availability` e
 * `/v1/tenants/me` são registradas pelo mesmo grupo que `/v1/tenants`, então o Fastify
 * já as desempata por rota estática — não há parâmetro que as engula.
 */
export async function registerIdentityRoutes(app: FastifyInstance): Promise<void> {
  await registerTenantRoutes(app)
  await registerOnboardingRoutes(app)
  await registerSettingsRoutes(app)
  await registerRbacRoutes(app)
  await registerInvitationRoutes(app)
  await registerMeRoutes(app)
}
