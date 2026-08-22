import { OnboardingStepSchema } from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../../auth/context.js'
import { parseInput } from '../../lib/validate.js'
import { ensureLocalUser } from '../users/service.js'
import { advanceOnboarding, getOnboardingState } from './service.js'

/** MOD-IDENT-02 — rotas do wizard. */

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/tenants/me/onboarding', async (request) => {
    const auth = requireTenantContext(request)
    return getOnboardingState(auth.tenantId)
  })

  app.patch(
    '/v1/tenants/me/onboarding',
    {
      preHandler: requirePermission(
        'tenant:configure',
        'Apenas o administrador pode concluir a configuração inicial',
      ),
    },
    async (request) => {
      const auth = requireTenantContext(request)
      // A validação da etapa 3 inclui `closesAt > opensAt`, o 422 do AC-02.
      const payload = parseInput(OnboardingStepSchema, request.body)
      const actor = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id
      return advanceOnboarding({ tenantId: auth.tenantId, actorUserId: actor, payload })
    },
  )
}
