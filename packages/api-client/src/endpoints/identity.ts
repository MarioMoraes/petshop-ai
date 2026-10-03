import {
  MeResponseSchema,
  PendingCountsSchema,
  type PendingCountsQuery,
  OnboardingStateSchema,
  InvitationPreviewSchema,
  InvitationResponseSchema,
  RoleResponseSchema,
  SlugAvailabilitySchema,
  TeamMemberSchema,
  MembershipActionResultSchema,
  SwitchTenantResultSchema,
  TenantResponseSchema,
  TenantSettingsSchema,
  type AcceptInvitationResult,
  type AssignableRoleKey,
  type CreateInvitationInput,
  type OnboardingStepInput,
  type UpdateTenantSettingsInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { toQueryString, type Transport } from '../transport.js'

export function identityEndpoints({ request }: Transport) {
  return {
    me: () => request({ method: 'GET', path: '/v1/me', schema: MeResponseSchema }),

    /**
     * "Já vi os agendamentos novos do Portal" — a marca do sino, gravada no vínculo.
     *
     * Devolve o instante que o **servidor** gravou, e não o que o browser achava que
     * era: o relógio de quem clica não decide o que é novidade.
     */
    markPortalBookingsSeen: () =>
      request({
        method: 'POST',
        path: '/v1/me/portal-bookings-seen',
        body: {},
        schema: z.object({ seenAt: z.iso.datetime() }),
      }),

    /**
     * O sino da moldura numa chamada só — as nove fontes, contadas pelo backend. Ver
     * `backend/app/src/gateway/pending.ts`.
     */
    getPendingCounts: (query: PendingCountsQuery = {}) =>
      request({
        method: 'GET',
        path: `/v1/me/pending${toQueryString(query)}`,
        schema: PendingCountsSchema,
      }),

    createTenant: (input: {
      name: string
      slug: string
      legalName?: string
      cnpj?: string
      plan?: string
      timezone?: string
    }) =>
      request({
        method: 'POST',
        path: '/v1/tenants',
        body: input,
        schema: TenantResponseSchema,
      }),

    getTenant: () =>
      request({ method: 'GET', path: '/v1/tenants/me', schema: TenantResponseSchema }),

    updateTenant: (input: { name?: string; legalName?: string | null; cnpj?: string | null }) =>
      request({
        method: 'PATCH',
        path: '/v1/tenants/me',
        body: input,
        schema: TenantResponseSchema,
      }),

    checkSlug: (slug: string) =>
      request({
        method: 'GET',
        path: `/v1/tenants/slug-availability?slug=${encodeURIComponent(slug)}`,
        schema: SlugAvailabilitySchema,
      }),

    getOnboarding: () =>
      request({
        method: 'GET',
        path: '/v1/tenants/me/onboarding',
        schema: OnboardingStateSchema,
      }),

    advanceOnboarding: (payload: OnboardingStepInput) =>
      request({
        method: 'PATCH',
        path: '/v1/tenants/me/onboarding',
        body: payload,
        schema: TenantResponseSchema,
      }),

    getSettings: () =>
      request({
        method: 'GET',
        path: '/v1/tenants/me/settings',
        schema: TenantSettingsSchema,
      }),

    updateSettings: (patch: UpdateTenantSettingsInput) =>
      request({
        method: 'PATCH',
        path: '/v1/tenants/me/settings',
        body: patch,
        schema: TenantSettingsSchema,
      }),

    // ─── MOD-IDENT-04/06 — equipe e convites ───────────────────────────────

    listTeam: () =>
      request({ method: 'GET', path: '/v1/memberships', schema: z.array(TeamMemberSchema) }),

    listRoles: () =>
      request({ method: 'GET', path: '/v1/roles', schema: z.array(RoleResponseSchema) }),

    changeMemberRole: (membershipId: string, role: AssignableRoleKey) =>
      request({
        method: 'PATCH',
        path: `/v1/memberships/${membershipId}`,
        body: { role },
      }),

    // ─── MOD-IDENT-05 — acesso da equipe e troca de estabelecimento ────────

    changeMemberStatus: (membershipId: string, status: 'ACTIVE' | 'SUSPENDED') =>
      request({
        method: 'PATCH',
        path: `/v1/memberships/${membershipId}/status`,
        body: { status },
        schema: MembershipActionResultSchema,
      }),

    removeMember: (membershipId: string) =>
      request({
        method: 'DELETE',
        path: `/v1/memberships/${membershipId}`,
        schema: MembershipActionResultSchema,
      }),

    /**
     * Confere o vínculo e audita a troca. **Quem de fato troca é o `setActive` do Clerk,
     * no navegador** — o `clerkOrgId` da resposta é o que ele pede.
     */
    switchTenant: (tenantId: string) =>
      request({
        method: 'POST',
        path: '/v1/sessions/switch-tenant',
        body: { tenantId },
        schema: SwitchTenantResultSchema,
      }),

    listInvitations: () =>
      request({
        method: 'GET',
        path: '/v1/invitations',
        schema: z.array(InvitationResponseSchema),
      }),

    createInvitation: (input: CreateInvitationInput) =>
      request({
        method: 'POST',
        path: '/v1/invitations',
        body: input,
        schema: InvitationResponseSchema,
      }),

    resendInvitation: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/invitations/${id}/resend`,
        schema: InvitationResponseSchema,
      }),

    revokeInvitation: (id: string) =>
      request<void>({ method: 'DELETE', path: `/v1/invitations/${id}` }),

    /** Rotas do convidado: exigem sessão, mas nenhum vínculo com o tenant ainda. */
    previewInvitation: (token: string) =>
      request({
        method: 'GET',
        path: `/v1/invitations/preview?token=${encodeURIComponent(token)}`,
        schema: InvitationPreviewSchema,
      }),

    acceptInvitation: (token: string) =>
      request<AcceptInvitationResult>({
        method: 'POST',
        path: '/v1/invitations/accept',
        body: { token },
      }),
  }
}
