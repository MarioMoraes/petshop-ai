import { AcceptInvitationSchema, CreateInvitationSchema } from '@petshop/shared-types'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requirePermission, requireTenantContext } from '../auth.js'
import { parseInput } from '../validate.js'
import { ensureLocalUser } from '../users/service.js'
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
  type ActorContext,
} from './service.js'

/** MOD-IDENT-06 — convites de equipe. */

const InvitationParamsSchema = z.object({ id: z.uuid() })
const TokenQuerySchema = z.object({ token: z.string().min(20).max(200) })

export async function registerInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/invitations',
    { preHandler: requirePermission('team:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listInvitations(auth.tenantId)
    },
  )

  app.post(
    '/v1/invitations',
    {
      preHandler: requirePermission(
        'team:invite',
        'Seu perfil não permite convidar pessoas para a equipe',
      ),
    },
    async (request, reply) => {
      const input = parseInput(CreateInvitationSchema, request.body)
      const invitation = await createInvitation(await actorOf(request), input)
      return reply.status(201).send(invitation)
    },
  )

  app.post(
    '/v1/invitations/:id/resend',
    {
      preHandler: requirePermission(
        'team:invite',
        'Seu perfil não permite convidar pessoas para a equipe',
      ),
    },
    async (request) => {
      const { id } = parseInput(InvitationParamsSchema, request.params)
      return resendInvitation(await actorOf(request), id)
    },
  )

  app.delete(
    '/v1/invitations/:id',
    {
      preHandler: requirePermission(
        'team:invite',
        'Seu perfil não permite cancelar convites da equipe',
      ),
    },
    async (request) => {
      const { id } = parseInput(InvitationParamsSchema, request.params)
      return revokeInvitation(await actorOf(request), id)
    },
  )

  /*
   * As duas rotas do convidado.
   *
   * Elas exigem sessão (o gateway já recusou quem não tem token), mas **não** exigem
   * tenant: quem chega aqui não é membro de lugar nenhum ainda — é exatamente o que o
   * convite vai resolver. A autorização é o próprio token do link, que ninguém
   * consegue adivinhar e de que o banco só guarda o hash.
   */
  app.get('/v1/invitations/preview', async (request) => {
    const { token } = parseInput(TokenQuerySchema, request.query)
    return previewInvitation(token)
  })

  app.post('/v1/invitations/accept', async (request) => {
    const { token } = parseInput(AcceptInvitationSchema, request.body)
    return acceptInvitation({
      token,
      clerkUserId: request.auth.clerkUserId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    })
  })
}

/** O ator das rotas administrativas, com o espelho local garantido. */
async function actorOf(request: Parameters<typeof requireTenantContext>[0]): Promise<ActorContext> {
  const auth = requireTenantContext(request)
  const actorUserId = auth.userId ?? (await ensureLocalUser(auth.clerkUserId)).id
  return {
    tenantId: auth.tenantId,
    actorUserId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  }
}
