import { listUserMemberships } from '@petshop/db'
import { ROLE_LABELS, type MeResponse, type RoleKey } from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { requireTenantContext } from '../auth.js'
import { getEffectivePermissions } from '../rbac/service.js'
import { getPrimaryColor } from '../settings/service.js'
import { getTenant } from '../tenants/service.js'
import { ensureLocalUser } from '../users/service.js'
import { markPortalBookingsSeen, readPortalBookingsSeenAt } from './service.js'

/**
 * `GET /v1/me` — perfil, vínculos e permissões efetivas.
 *
 * É a primeira chamada de toda sessão do frontend e o que decide o roteamento
 * (onboarding vs. dashboard). Fica sob o SLO mais apertado do PRD §10: p95 de 120ms.
 *
 * A listagem de vínculos é cross-tenant por natureza (RN-01) e por isso vem de
 * `listUserMemberships`, do conjunto de consultas de plataforma.
 */
export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', async (request): Promise<MeResponse> => {
    const user = await ensureLocalUser(request.auth.clerkUserId)
    const memberships = await listUserMemberships(user.id)

    const tenantId = request.auth.tenantId
    // As três consultas do tenant corrente são independentes entre si — em paralelo
    // por causa do SLO de p95 120ms desta rota.
    const [currentTenant, effective, primaryColor, portalBookingsSeenAt] = tenantId
      ? await Promise.all([
          getTenant(tenantId),
          getEffectivePermissions(tenantId, user.id),
          getPrimaryColor(tenantId),
          readPortalBookingsSeenAt(tenantId, user.id),
        ])
      : [null, null, null, null]

    return {
      user: {
        id: user.id,
        clerkUserId: user.clerkUserId,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        mfaEnabled: user.mfaEnabled,
      },
      currentTenant,
      primaryColor,
      memberships: memberships.map((membership) => ({
        tenantId: membership.tenantId,
        tenantName: membership.tenantName,
        tenantSlug: membership.tenantSlug,
        roleKey: membership.roleKey as RoleKey,
        roleLabel: ROLE_LABELS[membership.roleKey as RoleKey] ?? membership.roleKey,
        status: membership.status as 'ACTIVE' | 'SUSPENDED' | 'REMOVED',
      })),
      permissions: effective?.permissions ?? [],
      permVersion: effective?.permVersion ?? 0,
      /**
       * MOD-SEC-02 AC-04 — esta rota **nunca** é barrada, e é por este campo que a tela
       * decide entre a faixa de aviso e o bloqueio.
       *
       * O estado é resolvido na porta, por `resolveSession`, e chega aqui em
       * `request.mfa`. Recalculá-lo seria uma segunda leitura da mesma coisa, com o
       * risco de as duas divergirem. A sessão da porta interna não passa por lá, e o
       * padrão então é "não se aplica".
       */
      mfa: request.mfa ?? { required: false, enabled: false, graceEndsAt: null },
      /**
       * A marca do sino. Vem junto porque a moldura do Admin já espera por esta rota
       * antes de desenhar qualquer coisa — uma chamada própria só para ler um instante
       * atrasaria toda navegação para adiantar um contador.
       */
      portalBookingsSeenAt: portalBookingsSeenAt?.toISOString() ?? null,
    }
  })

  /**
   * `POST /v1/me/portal-bookings-seen` — "eu já vi os agendamentos novos do Portal".
   *
   * **Sem permissão própria.** A coluna é do vínculo de quem chama e não decide acesso
   * a nada; exigir uma permissão faria parte da equipe carregar um contador que não
   * tem como apagar.
   *
   * Também **sem trilha de auditoria**. A trilha registra o que mexe no negócio, e
   * abrir um painel não é isso — uma linha por abertura de sino afogaria a prova que
   * `audit_logs` existe para guardar.
   */
  app.post('/v1/me/portal-bookings-seen', async (request) => {
    const auth = requireTenantContext(request)
    const user = await ensureLocalUser(auth.clerkUserId)
    const seenAt = await markPortalBookingsSeen(auth.tenantId, user.id)
    return { seenAt: seenAt.toISOString() }
  })
}
