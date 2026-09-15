import {
  AnonymizeTutorSchema,
  AssignTagSchema,
  AddressInputSchema,
  CheckDuplicatesSchema,
  CreateDeletionRequestSchema,
  CreateTagSchema,
  CreateTutorSchema,
  DeletionRequestListQuerySchema,
  ListTutorsQuerySchema,
  MergeTutorSchema,
  PortalAdoptionQuerySchema,
  ResolveDeletionRequestSchema,
  UpdateAddressSchema,
  UpdateConsentsSchema,
  UpdateTutorSchema,
  onlyDigits,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from './auth.js'
import { lookupCep } from './cep-port.js'
import { notFound } from './errors.js'
import { parseInput } from './validate.js'
import { withTenant } from '@petshop/db'
import { addAddress, listAddresses, updateAddress } from '../addresses/service.js'
import { getConsents, updateConsents } from '../consents/service.js'
import { assignTag, createTag, listTags, removeTag } from '../tags/service.js'
import { findProbableDuplicates, toSearchKeys } from './dedupe.js'
import { mergeTutors } from './merge.js'
import { exportTutor, getTutorOverview } from './overview.js'
import { portalAdoption } from './portal-adoption.js'
import { portfolioQuality } from './portfolio.js'
import {
  countOpenDeletionRequests,
  listDeletionRequests,
  requestDeletion,
  resolveDeletionRequest,
} from './privacy.js'
import {
  anonymizeTutor,
  createTutor,
  deleteTutor,
  getTutor,
  listTutors,
  reactivateTutor,
  unlinkPortalAccess,
  revealTutorData,
  updateTutor,
  type ActorContext,
} from './service.js'

/**
 * Rotas do tutor-service (PRD tutores_02 §5).
 *
 * A matriz de acesso do §9 vira `requirePermission` em cada rota. Nenhum handler
 * verifica papel por conta própria: quem decide é a matriz de MOD-IDENT-04, e a
 * negação já sai auditada de lá.
 */

interface TutorParams {
  id: string
}

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerTutorRoutes(app: FastifyInstance): Promise<void> {
  // ─── Listagem e busca ──────────────────────────────────────────────────────

  app.get('/v1/tutors', { preHandler: requirePermission('tutor:read') }, async (request) => {
    const auth = requireTenantContext(request)
    const query = parseInput(ListTutorsQuerySchema, request.query)
    return listTutors(auth.tenantId, query)
  })

  app.post(
    '/v1/tutors',
    { preHandler: requirePermission('tutor:create', 'Seu perfil não permite cadastrar tutores') },
    async (request, reply) => {
      const input = parseInput(CreateTutorSchema, request.body)
      const tutor = await createTutor(actorOf(request), input)
      return reply.status(201).send(tutor)
    },
  )

  /** Chamado no blur do campo nome, antes de salvar (AC-02 de MOD-TUTOR-02). */
  app.post(
    '/v1/tutors/check-duplicates',
    { preHandler: requirePermission('tutor:create') },
    async (request) => {
      const auth = requireTenantContext(request)
      const input = parseInput(CheckDuplicatesSchema, request.body)
      return withTenant(auth.tenantId, (tx) =>
        findProbableDuplicates(tx, auth.tenantId, toSearchKeys(input)),
      )
    },
  )

  // ─── Tags — antes de `/v1/tutors/:id` para o `tags` não virar um id ─────────

  /**
   * Adoção do Portal — a faixa do Portal no painel do Início.
   *
   * `tenant:configure` é a permissão que liga e desliga o Portal, e adoção é a
   * pergunta de quem tomou essa decisão. Para o balcão o número não muda nada: quem
   * atende continua atendendo quem ligou.
   *
   * Precisa vir **antes** de `/v1/tutors/:id` no arquivo? Não — o Fastify prefere o
   * segmento estático ao parâmetro. Fica aqui, junto das outras rotas de coleção, por
   * leitura.
   */
  app.get(
    '/v1/tutors/reports/portal-adoption',
    { preHandler: requirePermission('tenant:configure') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(PortalAdoptionQuerySchema, request.query)
      return portalAdoption(auth.tenantId, query.days)
    },
  )

  /**
   * Qualidade da carteira — cadastros completos e opt-in de WhatsApp, na faixa "Sua base".
   *
   * `tutor:read`, o mesmo gate da contagem de tutores ao lado: os dois números são o
   * estado do cadastro, e quem vê a carteira vê o quanto ela está preenchida.
   */
  app.get(
    '/v1/tutors/reports/portfolio',
    { preHandler: requirePermission('tutor:read') },
    async (request) => portfolioQuality(requireTenantContext(request).tenantId),
  )

  app.get('/v1/tutors/tags', { preHandler: requirePermission('tutor:read') }, async (request) => {
    const auth = requireTenantContext(request)
    return listTags(auth.tenantId)
  })

  app.post(
    '/v1/tutors/tags',
    { preHandler: requirePermission('crm:manage', 'Somente o administrador cria tags') },
    async (request, reply) => {
      const input = parseInput(CreateTagSchema, request.body)
      const tag = await createTag(actorOf(request), input)
      return reply.status(201).send(tag)
    },
  )

  app.post<{ Params: { tagId: string } }>(
    '/v1/tutors/tags/:tagId/assign',
    { preHandler: requirePermission('tutor:update') },
    async (request) => {
      const input = parseInput(AssignTagSchema, request.body)
      return assignTag(actorOf(request), request.params.tagId, input.tutorIds)
    },
  )

  // ─── Consulta de CEP (MOD-TUTOR-03) ────────────────────────────────────────

  app.get<{ Querystring: { cep?: string } }>(
    '/v1/tutors/cep-lookup',
    { preHandler: requirePermission('tutor:read') },
    async (request) => {
      const cep = onlyDigits(request.query.cep ?? '')
      const result = await lookupCep(cep)
      if (!result) throw notFound('CEP não encontrado')
      return result
    },
  )

  // ─── Um tutor ──────────────────────────────────────────────────────────────

  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id',
    { preHandler: requirePermission('tutor:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getTutor(auth.tenantId, request.params.id)
    },
  )

  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id/overview',
    { preHandler: requirePermission('tutor:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getTutorOverview(auth.tenantId, request.params.id)
    },
  )

  /** Dados completos, sem máscara. Cada leitura vira `tutor.cpf_revealed`. */
  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id/sensitive',
    { preHandler: requirePermission('tutor:update', 'Seu perfil não permite ver o documento completo') },
    async (request) => revealTutorData(actorOf(request), request.params.id),
  )

  app.patch<{ Params: TutorParams }>(
    '/v1/tutors/:id',
    { preHandler: requirePermission('tutor:update') },
    async (request) => {
      const patch = parseInput(UpdateTutorSchema, request.body)
      return updateTutor(actorOf(request), request.params.id, patch)
    },
  )

  app.delete<{ Params: TutorParams }>(
    '/v1/tutors/:id',
    { preHandler: requirePermission('tutor:delete', 'Somente o administrador exclui tutores') },
    async (request, reply) => {
      await deleteTutor(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )

  app.post<{ Params: TutorParams }>(
    '/v1/tutors/:id/anonymize',
    { preHandler: requirePermission('tutor:delete', 'Somente o administrador anonimiza cadastros') },
    async (request, reply) => {
      const input = parseInput(AnonymizeTutorSchema, request.body)
      await anonymizeTutor(actorOf(request), request.params.id, input)
      return reply.status(204).send()
    },
  )

  /**
   * MOD-PORTAL, RN-05 — desfazer o acesso ao Portal desta ficha.
   *
   * Gate `tutor:update`, e não uma permissão nova: quem edita a ficha decide quem tem
   * acesso a ela. É a operação de equipe que o AC-04 de MOD-PORTAL-01 exige para
   * corrigir um vínculo errado — e a única, porque o Portal recusa a segunda conta.
   */
  app.delete<{ Params: TutorParams }>(
    '/v1/tutors/:id/portal-access',
    { preHandler: requirePermission('tutor:update') },
    async (request) => unlinkPortalAccess(actorOf(request), request.params.id),
  )

  app.post<{ Params: TutorParams }>(
    '/v1/tutors/:id/reactivate',
    { preHandler: requirePermission('tutor:update') },
    async (request) => reactivateTutor(actorOf(request), request.params.id),
  )

  app.post<{ Params: TutorParams }>(
    '/v1/tutors/:id/merge',
    { preHandler: requirePermission('tutor:delete', 'Somente o administrador unifica cadastros') },
    async (request) => {
      const input = parseInput(MergeTutorSchema, request.body)
      return mergeTutors(actorOf(request), request.params.id, input)
    },
  )

  // ─── Pedidos de exclusão de dados (LGPD art. 18, V) ────────────────────────
  //
  // As rotas de fila vêm **antes** das de `:id` por clareza, não por necessidade: o
  // roteador do Fastify já prefere segmento literal a parâmetro, como `/v1/tutors/tags`
  // já demonstrava. Ler na ordem em que o roteador resolve poupa a dúvida.

  /**
   * A fila da equipe.
   *
   * Gate `tutor:delete`, o mesmo da anonimização, e não `tutor:read`. A fila é uma lista
   * de decisões sobre apagar cadastro, e mostrá-la a quem não pode tomá-las produziria
   * uma pendência que a pessoa vê e não resolve — o sino da topbar contaria trabalho
   * alheio para a recepção inteira.
   */
  app.get(
    '/v1/tutors/deletion-requests',
    { preHandler: requirePermission('tutor:delete', 'Somente o administrador trata pedidos de exclusão') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(DeletionRequestListQuerySchema, request.query)
      return listDeletionRequests(auth.tenantId, query)
    },
  )

  /** Só o número, para o sino. Ver o motivo em `privacy.ts`. */
  app.get(
    '/v1/tutors/deletion-requests/count',
    { preHandler: requirePermission('tutor:delete') },
    async (request) => {
      const auth = requireTenantContext(request)
      return countOpenDeletionRequests(auth.tenantId)
    },
  )

  app.post<{ Params: { requestId: string } }>(
    '/v1/tutors/deletion-requests/:requestId/resolve',
    { preHandler: requirePermission('tutor:delete', 'Somente o administrador responde pedidos de exclusão') },
    async (request) => {
      const input = parseInput(ResolveDeletionRequestSchema, request.body)
      return resolveDeletionRequest(actorOf(request), request.params.requestId, input)
    },
  )

  /**
   * Registrar o pedido — pelo Portal ou pelo balcão.
   *
   * Gate `tutor:update`, e não `tutor:delete`: **pedir não é apagar.** Quem edita a ficha
   * registra o pedido que o tutor fez por telefone, e a decisão continua sendo de quem
   * tem `tutor:delete`. É também a permissão que o `tutor-port.ts` do `portal-bff` já
   * assina, o que evita uma segunda elevação para a mesma superfície.
   */
  app.post<{ Params: TutorParams }>(
    '/v1/tutors/:id/deletion-request',
    { preHandler: requirePermission('tutor:update') },
    async (request, reply) => {
      const input = parseInput(CreateDeletionRequestSchema, request.body ?? {})
      const created = await requestDeletion(actorOf(request), request.params.id, input)
      return reply.status(201).send(created)
    },
  )

  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id/export',
    { preHandler: requirePermission('tutor:read') },
    async (request) => exportTutor(actorOf(request), request.params.id),
  )

  // ─── Consentimento ─────────────────────────────────────────────────────────

  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id/consents',
    { preHandler: requirePermission('tutor:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getConsents(auth.tenantId, request.params.id)
    },
  )

  app.put<{ Params: TutorParams }>(
    '/v1/tutors/:id/consents',
    { preHandler: requirePermission('tutor:update') },
    async (request) => {
      const input = parseInput(UpdateConsentsSchema, request.body)
      return updateConsents(actorOf(request), request.params.id, input)
    },
  )

  // ─── Endereços ─────────────────────────────────────────────────────────────

  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id/addresses',
    { preHandler: requirePermission('tutor:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listAddresses(auth.tenantId, request.params.id)
    },
  )

  app.post<{ Params: TutorParams }>(
    '/v1/tutors/:id/addresses',
    { preHandler: requirePermission('tutor:update') },
    async (request, reply) => {
      const input = parseInput(AddressInputSchema, request.body)
      const address = await addAddress(actorOf(request), request.params.id, input)
      return reply.status(201).send(address)
    },
  )

  app.patch<{ Params: TutorParams & { addressId: string } }>(
    '/v1/tutors/:id/addresses/:addressId',
    { preHandler: requirePermission('tutor:update') },
    async (request) => {
      const patch = parseInput(UpdateAddressSchema, request.body)
      return updateAddress(actorOf(request), request.params.id, request.params.addressId, patch)
    },
  )

  app.delete<{ Params: TutorParams & { tagId: string } }>(
    '/v1/tutors/:id/tags/:tagId',
    { preHandler: requirePermission('tutor:update') },
    async (request, reply) => {
      await removeTag(actorOf(request), request.params.id, request.params.tagId)
      return reply.status(204).send()
    },
  )
}
