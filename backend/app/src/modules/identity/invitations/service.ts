import { createHash, randomBytes } from 'node:crypto'
import {
  Prisma,
  decryptForTenant,
  encryptForTenant,
  getPrisma,
  hashEmail,
  normalizeEmail,
  resolveInvitationByTokenHash,
  withTenant,
} from '@petshop/db'
import {
  IDENTITY_ROUTING_KEYS,
  PLAN_SEAT_LIMITS,
  ROLE_LABELS,
  isProfessionalRole,
  maskEmail,
  type AssignableRoleKey,
  type CreateInvitationInput,
  type InvitationPreview,
  type InvitationResponse,
  type Plan,
  type RoleKey,
} from '@petshop/shared-types'
import { loadEnv } from '../../../config/env.js'
import { recordAudit } from '../../../shared/audit.js'
import { getClerk } from '../clerk.js'
import { conflict, forbidden, gone, notFound, planLimitReached, tenantBlocked } from '../errors.js'
import { publishEvent } from '../../../shared/events.js'
import { logger } from '../../../shared/logger.js'
import { getMailer } from '../mailer.js'
import { mfaGraceFor } from '../../security/mfa.js'
import { invalidatePermissions } from '../rbac/service.js'
import { getScheduling } from '../scheduling-port.js'
import { ensureLocalUser } from '../users/service.js'

/**
 * MOD-IDENT-06 — Convites de Equipe.
 *
 * O convite é uma **capacidade em forma de link**: um token aleatório de 32 bytes de
 * que só o hash fica no banco. Quem tem o link tem a prova; o servidor não consegue
 * reconstruí-lo nem para reexibir, o que é o mesmo tratamento que se dá a uma senha.
 *
 * O aceite é o ponto delicado do módulo, porque atravessa dois sistemas. O tenant de
 * uma sessão é resolvido pelo claim `org_id` do JWT do Clerk (ver `session.ts` do
 * gateway), então criar o membership local **sem** colocar a pessoa na Organization
 * produziria alguém que entra no produto e não enxerga estabelecimento nenhum — o
 * pior estado possível, porque não parece erro. A ordem aqui é: commit local
 * primeiro, Clerk depois, e o aceite é idempotente justamente para que uma falha do
 * Clerk seja recuperável clicando no mesmo link de novo.
 */

const TOKEN_BYTES = 32

export interface ActorContext {
  tenantId: string
  actorUserId: string
  ipAddress?: string | null
  userAgent?: string | null
}

// ─── Criar (AC-01) ───────────────────────────────────────────────────────────

export async function createInvitation(
  actor: ActorContext,
  input: CreateInvitationInput,
): Promise<InvitationResponse> {
  const email = normalizeEmail(input.email)
  const emailHash = hashEmail(email)

  await assertNotAlreadyMember(actor.tenantId, emailHash)
  await assertSeatAvailable(actor.tenantId)

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + loadEnv().INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.invitation.create({
        data: {
          tenantId: actor.tenantId,
          emailEncrypted: await encryptForTenant(tx, actor.tenantId, email),
          emailHash,
          roleKey: input.role,
          tokenHash: hashToken(token),
          status: 'PENDING',
          expiresAt,
          invitedBy: actor.actorUserId,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: 'invitation.created',
        entity: 'invitation',
        entityId: row.id,
        // O e-mail não vai para a trilha: `audit_logs` é append-only e sobreviveria
        // ao expurgo do convite. O hash basta para correlacionar.
        after: { roleKey: input.role, emailHash, expiresAt: expiresAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return row
    },
    { userId: actor.actorUserId },
  ).catch(handlePendingConflict)

  await publishEvent(IDENTITY_ROUTING_KEYS.conviteCriado, {
    tenantId: actor.tenantId,
    invitationId: created.id,
    roleKey: input.role,
    invitedByUserId: actor.actorUserId,
  })

  const inviteUrl = buildInviteUrl(token)
  await deliver(actor.tenantId, actor.actorUserId, {
    to: email,
    roleKey: input.role,
    inviteUrl,
    expiresAt,
  })

  return { ...(await present(created, email)), inviteUrl }
}

// ─── Listar ──────────────────────────────────────────────────────────────────

/**
 * A tela de equipe mostra os convites junto dos membros, então a lista traz também
 * os já resolvidos — quem revogou um convite ontem precisa ver que revogou.
 * `ACCEPTED` fica de fora: essa pessoa já aparece na lista de membros, e mostrá-la
 * duas vezes faria a equipe parecer maior do que é.
 */
export async function listInvitations(tenantId: string): Promise<InvitationResponse[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.invitation.findMany({
      where: { status: { not: 'ACCEPTED' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  )

  const emails = await decryptEmails(tenantId, rows)
  const inviterNames = await namesOf(rows.map((row) => row.invitedBy))

  return rows.map((row, index) => ({
    id: row.id,
    email: emails[index] ?? '',
    roleKey: row.roleKey as RoleKey,
    roleLabel: ROLE_LABELS[row.roleKey as RoleKey] ?? row.roleKey,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    invitedByName: row.invitedBy ? (inviterNames.get(row.invitedBy) ?? null) : null,
  }))
}

// ─── Reenviar ────────────────────────────────────────────────────────────────

/**
 * Reenviar **troca o token**. O link antigo morre no mesmo instante.
 *
 * É o que torna o reenvio útil como conserto: convite mandado para o e-mail errado,
 * link vazado num grupo, prazo estourado — em todos os casos o que se quer é que só
 * o link novo funcione. Manter o antigo vivo transformaria "reenviar" em "duplicar".
 */
export async function resendInvitation(
  actor: ActorContext,
  invitationId: string,
): Promise<InvitationResponse> {
  const current = await withTenant(actor.tenantId, (tx) =>
    tx.invitation.findFirst({
      where: { id: invitationId, tenantId: actor.tenantId },
      select: { id: true, status: true, expiresAt: true },
    }),
  )
  if (!current) throw notFound('Convite não encontrado')
  if (current.status === 'ACCEPTED') {
    throw conflict('Este convite já foi aceito — a pessoa está na sua equipe')
  }

  // Só se verifica assento ao **ressuscitar** um convite. Um pendente dentro do prazo
  // já ocupa o lugar dele: cobrar de novo faria um plano no limite recusar o reenvio
  // dos próprios convites — justamente quando reenviar é a única saída.
  if (current.status !== 'PENDING' || current.expiresAt.getTime() < Date.now()) {
    await assertSeatAvailable(actor.tenantId)
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + loadEnv().INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const { row, email } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const updated = await tx.invitation.update({
        where: { id: invitationId },
        data: { tokenHash: hashToken(token), status: 'PENDING', expiresAt },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: 'invitation.resent',
        entity: 'invitation',
        entityId: invitationId,
        before: { status: current.status, expiresAt: current.expiresAt.toISOString() },
        after: { status: 'PENDING', expiresAt: expiresAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        row: updated,
        email: await decryptForTenant(tx, actor.tenantId, updated.emailEncrypted),
      }
    },
    { userId: actor.actorUserId },
  ).catch(handlePendingConflict)

  const inviteUrl = buildInviteUrl(token)
  await deliver(actor.tenantId, actor.actorUserId, {
    to: email,
    roleKey: row.roleKey as AssignableRoleKey,
    inviteUrl,
    expiresAt,
  })

  return { ...(await present(row, email)), inviteUrl }
}

// ─── Revogar ─────────────────────────────────────────────────────────────────

export async function revokeInvitation(
  actor: ActorContext,
  invitationId: string,
): Promise<{ id: string; status: 'REVOKED' }> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const current = await tx.invitation.findFirst({
        where: { id: invitationId, tenantId: actor.tenantId },
        select: { id: true, status: true },
      })
      if (!current) throw notFound('Convite não encontrado')
      if (current.status === 'ACCEPTED') {
        // Revogar um convite aceito não desfaz nada: quem tira alguém da equipe é
        // `DELETE /v1/memberships/:id`. Dizer isso é melhor do que um 200 inócuo.
        throw conflict('Este convite já foi aceito — remova a pessoa pela lista da equipe')
      }
      if (current.status === 'REVOKED') return

      await tx.invitation.update({
        where: { id: invitationId },
        data: { status: 'REVOKED' },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: 'invitation.revoked',
        entity: 'invitation',
        entityId: invitationId,
        before: { status: current.status },
        after: { status: 'REVOKED' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    { userId: actor.actorUserId },
  )

  await publishEvent(IDENTITY_ROUTING_KEYS.conviteRevogado, {
    tenantId: actor.tenantId,
    invitationId,
    actorUserId: actor.actorUserId,
  })

  return { id: invitationId, status: 'REVOKED' }
}

// ─── Prévia da tela pública ──────────────────────────────────────────────────

export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const invitation = await resolveInvitationByTokenHash(hashToken(token))
  if (!invitation) throw notFound('Convite não encontrado')

  const status = effectiveStatus(invitation.status, invitation.expiresAt)
  const email = await withTenant(invitation.tenantId, async (tx) => {
    const row = await tx.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { emailEncrypted: true },
    })
    return decryptForTenant(tx, invitation.tenantId, row.emailEncrypted)
  })

  return {
    tenantName: invitation.tenantName,
    roleKey: invitation.roleKey as RoleKey,
    roleLabel: ROLE_LABELS[invitation.roleKey as RoleKey] ?? invitation.roleKey,
    maskedEmail: maskEmail(email),
    expiresAt: invitation.expiresAt.toISOString(),
    status,
  }
}

// ─── Aceitar ─────────────────────────────────────────────────────────────────

export interface AcceptParams {
  token: string
  clerkUserId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export async function acceptInvitation(params: AcceptParams) {
  const invitation = await resolveInvitationByTokenHash(hashToken(params.token))
  if (!invitation) throw notFound('Convite não encontrado')

  if (['SUSPENDED', 'TERMINATED', 'TRIAL_EXPIRED'].includes(invitation.tenantStatus)) {
    throw tenantBlocked('Este estabelecimento não está ativo. Fale com quem administra o petshop.')
  }

  const user = await ensureLocalUser(params.clerkUserId)

  // Quem aceita tem que ser quem foi convidado. Sem esta comparação o link, que pode
  // ser encaminhado, valeria como convite aberto para qualquer conta.
  if (hashEmail(user.email) !== invitation.emailHash) {
    throw forbidden(
      'Este convite foi enviado para outro e-mail. Entre com a conta que recebeu o convite, ou peça um novo.',
    )
  }

  const status = effectiveStatus(invitation.status, invitation.expiresAt)

  if (status === 'ACCEPTED') {
    // Idempotência: o aceite grava o membership e só então fala com o Clerk. Se a
    // segunda metade falhou, a pessoa clica no link de novo e cai aqui — refazemos
    // apenas o passo do Clerk, que é o que faltou.
    const existing = await findMembershipOf(invitation.tenantId, user.id)
    if (existing) {
      await joinClerkOrganization(
        invitation.clerkOrgId,
        params.clerkUserId,
        invitation.tenantId,
        user.id,
      )
      return presentAccept(invitation, existing.roleKey as RoleKey)
    }
    throw gone('Este convite já foi utilizado. Peça um novo ao administrador.')
  }

  if (status === 'EXPIRED') {
    await markExpired(invitation.tenantId, invitation.id)
    throw gone('Convite expirado — peça um novo ao administrador')
  }
  if (status === 'REVOKED') {
    throw gone('Este convite foi cancelado. Peça um novo ao administrador.')
  }

  // RN-11 de novo, aqui: entre o convite e o aceite cabe um downgrade de plano.
  await assertSeatAvailable(invitation.tenantId, invitation.tenantPlan as Plan)

  const roleKey = invitation.roleKey as AssignableRoleKey

  const mirror = await withTenant(
    invitation.tenantId,
    async (tx) => {
      const previous = await tx.membership.findFirst({
        where: { tenantId: invitation.tenantId, userId: user.id },
        select: { id: true, status: true },
      })

      if (previous) {
        // Alguém que saiu da equipe e voltou: o vínculo é reaproveitado, com
        // `permVersion` incrementado para derrubar qualquer token antigo.
        await tx.membership.update({
          where: { id: previous.id },
          data: {
            roleKey,
            status: 'ACTIVE',
            isProfessional: isProfessionalRole(roleKey),
            permVersion: { increment: 1 },
            // MOD-SEC-03: quem volta como administrador começa a carência do zero.
            mfaGraceUntil: mfaGraceFor(roleKey),
          },
        })
      } else {
        await tx.membership.create({
          data: {
            tenantId: invitation.tenantId,
            userId: user.id,
            roleKey,
            status: 'ACTIVE',
            isProfessional: isProfessionalRole(roleKey),
            mfaGraceUntil: mfaGraceFor(roleKey),
          },
        })
      }

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      })

      await recordAudit(tx, {
        tenantId: invitation.tenantId,
        actorUserId: user.id,
        action: 'invitation.accepted',
        entity: 'invitation',
        entityId: invitation.id,
        after: { userId: user.id, roleKey },
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      })

      /**
       * RN-06 — quem entra pelo convite já entra na agenda.
       *
       * É o caminho **normal** de contratar alguém: o convite carrega o papel, e sem
       * isto o administrador daria `GROOMER` a uma banhista e não a encontraria no
       * assistente de marcar horário. O ator da trilha é o próprio convidado, que é
       * quem está na requisição — o convite é dele.
       */
      return isProfessionalRole(roleKey)
        ? await getScheduling().mirrorProfessional(tx, invitation.tenantId, {
            userId: user.id,
            displayName: user.fullName,
            roleKey,
            actorUserId: user.id,
          })
        : null
    },
    { userId: user.id },
  )

  if (mirror) {
    await getScheduling().announceProfessionalChange(invitation.tenantId, mirror)
  }

  await invalidatePermissions(invitation.tenantId, user.id)
  await joinClerkOrganization(
    invitation.clerkOrgId,
    params.clerkUserId,
    invitation.tenantId,
    user.id,
  )

  await publishEvent(IDENTITY_ROUTING_KEYS.conviteAceito, {
    tenantId: invitation.tenantId,
    invitationId: invitation.id,
    userId: user.id,
    roleKey,
  })
  await publishEvent(IDENTITY_ROUTING_KEYS.membershipCriado, {
    tenantId: invitation.tenantId,
    userId: user.id,
    roleKey,
    isProfessional: isProfessionalRole(roleKey),
  })

  return presentAccept(invitation, roleKey)
}

// ─── Apoio ───────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function buildInviteUrl(token: string): string {
  return `${loadEnv().APP_URL.replace(/\/$/, '')}/convite/${token}`
}

/**
 * O status que o mundo vê. `PENDING` com prazo vencido já é `EXPIRED` para todos os
 * efeitos — o job que grava isso no banco roda uma vez por dia, e ninguém deveria
 * conseguir usar um convite morto na janela entre o vencimento e a varredura.
 */
function effectiveStatus(status: string, expiresAt: Date): InvitationPreview['status'] {
  if (status === 'PENDING' && expiresAt.getTime() < Date.now()) return 'EXPIRED'
  return status as InvitationPreview['status']
}

async function assertNotAlreadyMember(tenantId: string, emailHash: string): Promise<void> {
  // `users` é global e sem RLS: a busca por hash é feita fora do escopo do tenant, e
  // só o `id` encontrado é usado para perguntar ao tenant se há vínculo.
  const user = await getPrisma().user.findUnique({ where: { emailHash }, select: { id: true } })
  if (!user) return

  const membership = await withTenant(tenantId, (tx) =>
    tx.membership.findFirst({
      where: { tenantId, userId: user.id, status: { not: 'REMOVED' } },
      select: { id: true },
    }),
  )
  if (membership) throw conflict('Esta pessoa já faz parte da sua equipe')
}

/**
 * RN-11 — limite de usuários por plano.
 *
 * Convite pendente ocupa lugar. Sem isso, um plano de 5 assentos aceitaria vinte
 * convites e o problema só apareceria no aceite — para o convidado, que não tem nada
 * a ver com a assinatura do petshop.
 */
async function assertSeatAvailable(tenantId: string, knownPlan?: Plan): Promise<void> {
  const plan =
    knownPlan ??
    ((
      await withTenant(tenantId, (tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: true } }),
      )
    ).plan as Plan)

  const limit = PLAN_SEAT_LIMITS[plan]
  if (limit === null) return

  const used = await withTenant(tenantId, async (tx) => {
    const [members, pending] = await Promise.all([
      tx.membership.count({ where: { tenantId, status: { not: 'REMOVED' } } }),
      tx.invitation.count({
        where: { tenantId, status: 'PENDING', expiresAt: { gt: new Date() } },
      }),
    ])
    return members + pending
  })

  if (used >= limit) {
    const label = plan.charAt(0) + plan.slice(1).toLowerCase()
    throw planLimitReached(
      `Limite de usuários do plano ${label} atingido (${limit}). Faça upgrade para adicionar mais.`,
    )
  }
}

/** O índice único parcial `idx_invitations_pending` é a autoridade sobre duplicidade. */
function handlePendingConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw conflict(
      'Já existe um convite pendente para este e-mail. Reenvie ou cancele o convite atual.',
    )
  }
  throw error
}

async function findMembershipOf(tenantId: string, userId: string) {
  return withTenant(tenantId, (tx) =>
    tx.membership.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      select: { id: true, roleKey: true },
    }),
  )
}

async function markExpired(tenantId: string, invitationId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.invitation.update({ where: { id: invitationId }, data: { status: 'EXPIRED' } }),
  )
}

/**
 * O passo que faz o convite valer no Clerk. Falhar aqui **não** desfaz o membership:
 * o vínculo local já está comitado e o mesmo link, clicado de novo, refaz só esta
 * metade (ver o ramo `ACCEPTED` de `acceptInvitation`).
 */
async function joinClerkOrganization(
  clerkOrgId: string | null,
  clerkUserId: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  if (!clerkOrgId) {
    logger.error({ tenantId }, 'tenant sem Organization no Clerk — aceite sem vínculo de sessão')
    throw conflict(
      'O estabelecimento ainda está sendo preparado. Tente novamente em alguns minutos.',
    )
  }

  await getClerk().addOrganizationMembership({ organizationId: clerkOrgId, clerkUserId })
  await publishPermVersion(clerkOrgId, clerkUserId, tenantId, userId)
}

/**
 * Semeia o `permVersion` no metadata do membership recém-criado.
 *
 * Sem isto o convidado entrava na equipe com o metadata vazio, e o JWT template
 * publicava o claim como `null` — a segunda garantia do RN-03 (token divergente força
 * releitura do papel) só passava a valer depois da **primeira troca de papel**, que é
 * quando `syncPermVersionToClerk` do MOD-IDENT-04 escrevia o valor pela primeira vez.
 * Quem foi convidado e nunca mudou de papel — a maioria da equipe — ficava só com a
 * invalidação de cache. O provisionamento (MOD-IDENT-01) já semeava o valor para o
 * admin; era assimetria, não decisão.
 *
 * Best-effort pelo mesmo motivo de lá: falhar aqui não pode desfazer um aceite que já
 * está comitado, e o que se perde é o atalho, não a correção.
 */
async function publishPermVersion(
  clerkOrgId: string,
  clerkUserId: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  try {
    const membership = await withTenant(tenantId, (tx) =>
      tx.membership.findFirst({
        where: { tenantId, userId, status: 'ACTIVE' },
        select: { permVersion: true },
      }),
    )
    if (!membership) return

    await getClerk().setMembershipPermVersion({
      organizationId: clerkOrgId,
      clerkUserId,
      permVersion: membership.permVersion,
    })
  } catch (error) {
    logger.warn({ err: error, tenantId, userId }, 'falha ao semear permVersion no Clerk')
  }
}

interface DeliverParams {
  to: string
  roleKey: AssignableRoleKey
  inviteUrl: string
  expiresAt: Date
}

/**
 * O e-mail é best-effort de propósito: o convite já está gravado quando chegamos
 * aqui, e o link volta na resposta da API. Um provedor fora do ar não pode impedir o
 * admin de convidar alguém — ele copia o link e manda pelo WhatsApp, que é como
 * metade dos petshops faria de qualquer jeito.
 */
async function deliver(
  tenantId: string,
  actorUserId: string,
  params: DeliverParams,
): Promise<void> {
  const [tenant, inviter] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    ),
    getPrisma().user.findUnique({ where: { id: actorUserId }, select: { fullName: true } }),
  ])

  const sent = await getMailer().sendInvitation({
    to: params.to,
    tenantName: tenant.name,
    roleLabel: ROLE_LABELS[params.roleKey],
    inviteUrl: params.inviteUrl,
    invitedByName: inviter?.fullName ?? null,
    expiresAt: params.expiresAt,
  })

  if (!sent) logger.warn({ tenantId }, 'convite criado sem e-mail entregue')
}

async function decryptEmails(
  tenantId: string,
  rows: { emailEncrypted: string }[],
): Promise<string[]> {
  if (rows.length === 0) return []
  return withTenant(tenantId, async (tx) => {
    const out: string[] = []
    for (const row of rows) {
      out.push(await decryptForTenant(tx, tenantId, row.emailEncrypted))
    }
    return out
  })
}

/** Nomes de quem convidou. `users` é global: a busca é por id, fora do RLS. */
async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))]
  if (unique.length === 0) return new Map()
  const users = await getPrisma().user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true },
  })
  return new Map(users.map((user) => [user.id, user.fullName]))
}

interface InvitationRow {
  id: string
  roleKey: string
  status: string
  expiresAt: Date
  createdAt: Date
  acceptedAt: Date | null
  invitedBy: string | null
}

async function present(row: InvitationRow, email: string): Promise<InvitationResponse> {
  const names = await namesOf([row.invitedBy])
  return {
    id: row.id,
    email,
    roleKey: row.roleKey as RoleKey,
    roleLabel: ROLE_LABELS[row.roleKey as RoleKey] ?? row.roleKey,
    status: row.status as InvitationResponse['status'],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    invitedByName: row.invitedBy ? (names.get(row.invitedBy) ?? null) : null,
  }
}

function presentAccept(
  invitation: { tenantId: string; tenantName: string; tenantSlug: string },
  roleKey: RoleKey,
) {
  return {
    tenantId: invitation.tenantId,
    tenantName: invitation.tenantName,
    tenantSlug: invitation.tenantSlug,
    roleKey,
    roleLabel: ROLE_LABELS[roleKey] ?? roleKey,
  }
}
