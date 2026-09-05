import { withTenant } from '@petshop/db'
import {
  PortalAppointmentsQuerySchema,
  PortalAvailabilityQuerySchema,
  PortalBookingSchema,
  PortalCancelSchema,
  PortalChallengeSchema,
  PortalRescheduleSchema,
  PortalStatementQuerySchema,
  PortalTimelineQuerySchema,
  PortalVerifySchema,
  UpdateOwnPetSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  requireOwnScope,
  requirePermission,
  requireTenantContext,
  requireTutorContext,
} from '../../auth/context.js'
import { forbidden, invalid, unauthorized } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from './actor.js'
import type { SchedulingCaller } from './scheduling-port.js'
import { requestChallenge } from './challenge.js'
import {
  cancelOwnAppointment,
  listOwnAppointments,
  readOwnAppointment,
  rescheduleOwnAppointment,
} from './appointments.js'
import { createBooking, listBookableServices, readAvailability } from './booking.js'
import { readOwnFinance, readOwnReceipt, readOwnStatement } from './finance.js'
import { readPortalContext, readPortalTenant, touchLastSeen } from './me.js'
import { listOwnPets, readOwnPet, updateOwnPet } from './pets.js'
import { readTaxiOffer } from './taxi.js'
import { readOwnPetTimeline } from './timeline.js'
import { verifyChallenge } from './verify.js'

/**
 * As rotas do Portal (PRD portal_tutor_09 §5).
 *
 * A fatia 1 entregou a **porta** — identidade, escopo e contexto. A fatia 2 abre os
 * cômodos que já são do tutor: os pets e a história de cada um.
 *
 * A partir daqui as rotas param de chamar `requireTutorContext` direto e passam a
 * declarar a permissão `_own` no `preHandler`, lendo o recorte de `requireOwnScope`.
 * A troca não é estilística: quem lê o escopo **não compila** sem ter passado pelo
 * gate, e é assim que o RN-02 — "handler que esquece de filtrar não deve ser possível" —
 * deixa de depender de disciplina. `/me` fica de fora porque é a rota que descreve a
 * sessão em si, e não um recurso sob escopo.
 *
 * O prefixo é `/portal/v1`, e não `/v1`. A separação é o que permite ao gateway ter
 * allowlist e rate limit próprios para a superfície do cliente final — e é o que garante
 * que nenhum papel `TUTOR` alcance uma rota administrativa (AC-04 de MOD-PORTAL-11).
 */

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

/**
 * Quem o BFF diz ser ao falar com o scheduling-service.
 *
 * O `userId` é o do tutor, e não o de um usuário de serviço: é ele que vira
 * `created_by` do agendamento e autor na trilha de auditoria do outro lado. Um
 * agendamento sem autor real seria indefensável na primeira reclamação.
 */
function callerOf(request: FastifyRequest): SchedulingCaller {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    clerkUserId: auth.clerkUserId,
    userId: auth.userId ?? undefined,
  }
}

// ─── Superfície pública ──────────────────────────────────────────────────────

export async function registerPublicPortalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A identidade visual do petshop, para a tela de login.
   *
   * O tenant já vem resolvido pelo gateway, a partir do host — esta rota não decide de
   * quem é a página, só a descreve.
   */
  app.get('/portal/v1/tenant', async (request) => {
    const auth = requireTenantContext(request)
    return readPortalTenant(auth.tenantId)
  })
}

// ─── Superfície autenticada ──────────────────────────────────────────────────

export async function registerPortalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * MOD-PORTAL-01 — pedir o código.
   *
   * **Exige sessão do Clerk**, divergindo do §5 do PRD, que a marcou como pública. O
   * §4 do mesmo documento declara `clerk_user_id` obrigatório na linha do desafio, e as
   * duas coisas não cabem juntas: sem sessão não há quem gravar ali, e sem o campo o
   * vínculo não pode exigir que **o mesmo** usuário verifique — um código interceptado
   * valeria para qualquer conta.
   *
   * Nada da defesa se perde com isso: o 202 uniforme, o honeypot e o piso de tempo
   * continuam valendo. O que muda é que varrer a base do petshop passa a custar uma
   * conta no Clerk por varredura.
   */
  app.post('/portal/v1/access/challenge', async (request, reply) => {
    const auth = requireTenantContext(request)
    const input = parseInput(PortalChallengeSchema, request.body)

    const response = await requestChallenge({
      actor: actorOf(request),
      clerkUserId: auth.clerkUserId,
      input,
    })

    return reply.status(202).send(response)
  })

  /** MOD-PORTAL-01, AC-02 — consumir o código e criar o vínculo. */
  app.post('/portal/v1/access/verify', async (request) => {
    const auth = requireTenantContext(request)
    const input = parseInput(PortalVerifySchema, request.body)

    if (!auth.userId) {
      // O espelho local do usuário do Clerk ainda não existe. Sem ele não há o que
      // gravar em `portal_user_id` — e o vínculo apontaria para ninguém.
      logger.warn({ clerkUserId: auth.clerkUserId }, 'verificação sem espelho local do usuário')
      throw unauthorized('Não foi possível concluir o acesso. Entre novamente.')
    }

    return verifyChallenge({
      actor: actorOf(request),
      clerkUserId: auth.clerkUserId,
      userId: auth.userId,
      input,
    })
  })

  /** MOD-PORTAL-02 — o contexto do tutor autenticado. */
  app.get('/portal/v1/me', async (request) => {
    const auth = requireTutorContext(request)

    const context = await withTenant(auth.tenantId, (tx) =>
      readPortalContext(tx, auth.tenantId, auth.tutorId),
    )

    // RN-15: o Portal desligado tranca a casa, não a porta — quem já entrou precisa
    // saber por que não há nada a fazer aqui, e a mensagem é do estabelecimento.
    if (!context.features.portalEnabled) {
      throw forbidden('O Portal está indisponível neste estabelecimento no momento.')
    }

    // Métrica de adoção, fora do caminho da resposta.
    void touchLastSeen(auth.tenantId, auth.tutorId).catch((error: unknown) => {
      logger.warn({ err: error }, 'falha ao marcar a visita do tutor')
    })

    return context
  })

  // ─── MOD-PORTAL-03 — Meus Pets ─────────────────────────────────────────────

  app.get(
    '/portal/v1/pets',
    { preHandler: requirePermission('pet:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      return { pets: await listOwnPets(tenantId, tutorId) }
    },
  )

  app.get(
    '/portal/v1/pets/:petId',
    { preHandler: requirePermission('pet:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const { petId } = request.params as { petId: string }
      return readOwnPet(tenantId, tutorId, petId)
    },
  )

  /**
   * AC-02 e AC-03 de MOD-PORTAL-03.
   *
   * O 422 do campo travado nasce do `UpdateOwnPetSchema`, aqui no `parseInput`: peso,
   * porte, raça e pelagem não chegam ao handler porque o schema é `.strict()` e não os
   * declara. A trava é o contrato, e não uma checagem que alguém possa esquecer de
   * repetir na próxima rota de escrita.
   */
  app.patch(
    '/portal/v1/pets/:petId',
    { preHandler: requirePermission('pet:update_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const { petId } = request.params as { petId: string }
      const input = parseInput(UpdateOwnPetSchema, request.body)

      return updateOwnPet(tenantId, tutorId, petId, input)
    },
  )

  // ─── MOD-PORTAL-04 — Histórico do Pet ──────────────────────────────────────

  app.get(
    '/portal/v1/pets/:petId/timeline',
    { preHandler: requirePermission('pet:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const { petId } = request.params as { petId: string }
      const query = parseInput(PortalTimelineQuerySchema, request.query)

      return readOwnPetTimeline(tenantId, tutorId, petId, query)
    },
  )

  // ─── MOD-PORTAL-05 — Agendamento Online ────────────────────────────────────

  /**
   * O cardápio deste pet, com preço.
   *
   * `schedule:write_own` e não `read_own`: esta lista só existe para quem vai marcar.
   * Quem só quer saber quanto custa um banho lê a página pública do petshop, que é
   * onde a vitrine mora.
   */
  app.get(
    '/portal/v1/booking/services',
    { preHandler: requirePermission('schedule:write_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const { petId } = request.query as { petId?: string }
      if (!petId) throw invalid('Informe o pet')

      return listBookableServices(tenantId, tutorId, petId)
    },
  )

  app.get(
    '/portal/v1/booking/availability',
    { preHandler: requirePermission('schedule:write_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const query = parseInput(PortalAvailabilityQuerySchema, request.query)

      return readAvailability(callerOf(request), tutorId, query)
    },
  )

  /**
   * AC-03 — cria o agendamento.
   *
   * **201 quando nasce, 200 quando o pedido reencontrou o que já existia.** A diferença
   * importa para quem depura: dois 201 seguidos seriam duas linhas na agenda, e é
   * justamente o que o reconhecimento do duplo toque impede.
   */
  app.post(
    '/portal/v1/booking',
    { preHandler: requirePermission('schedule:write_own') },
    async (request, reply) => {
      const { tutorId } = requireOwnScope(request)
      const input = parseInput(PortalBookingSchema, request.body)

      const booking = await createBooking(callerOf(request), tutorId, input)
      return reply.status(booking.duplicate ? 200 : 201).send(booking)
    },
  )

  // ─── MOD-PORTAL-07 — Taxi Dog no Agendamento ───────────────────────────────

  /**
   * AC-02 — quanto custa o leva-e-traz para o endereço deste tutor.
   *
   * `schedule:write_own` e não uma permissão de taxi: o leva-e-traz não é um pedido
   * próprio no Portal, é uma opção do agendamento (decisão de produto de 2026-08-28).
   * Quem pode marcar horário pode perguntar o preço do transporte; quem não pode, não
   * tem o que fazer com a resposta.
   *
   * Responde 200 mesmo quando o leva-e-traz **não** está disponível — ver a divergência
   * explicada em `readTaxiOffer`.
   */
  app.get(
    '/portal/v1/booking/taxi',
    { preHandler: requirePermission('schedule:write_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      return readTaxiOffer(callerOf(request), tutorId)
    },
  )

  // ─── MOD-PORTAL-06 — Meus Agendamentos ─────────────────────────────────────

  app.get(
    '/portal/v1/appointments',
    { preHandler: requirePermission('schedule:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const query = parseInput(PortalAppointmentsQuerySchema, request.query)

      return listOwnAppointments(tenantId, tutorId, query)
    },
  )

  app.get(
    '/portal/v1/appointments/:appointmentId',
    { preHandler: requirePermission('schedule:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const { appointmentId } = request.params as { appointmentId: string }

      return readOwnAppointment(tenantId, tutorId, appointmentId)
    },
  )

  /**
   * AC-02 e AC-03 — cancelar.
   *
   * A primeira tentativa de um cancelamento tardio com taxa volta `ERR_PORTAL_011` com
   * o valor; a tela mostra a consequência e reenvia com `acknowledgeFee`. É o mesmo
   * desenho do reconhecimento de alerta clínico do MOD-AGENDA, e pelo mesmo motivo:
   * quem assume o custo precisa ter dito que sabia dele.
   */
  app.post(
    '/portal/v1/appointments/:appointmentId/cancel',
    { preHandler: requirePermission('schedule:write_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const { appointmentId } = request.params as { appointmentId: string }
      const input = parseInput(PortalCancelSchema, request.body ?? {})

      return cancelOwnAppointment(callerOf(request), tutorId, appointmentId, input)
    },
  )

  /** AC-04 — remarcar. Devolve o agendamento **novo**; o anterior vira histórico. */
  app.post(
    '/portal/v1/appointments/:appointmentId/reschedule',
    { preHandler: requirePermission('schedule:write_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const { appointmentId } = request.params as { appointmentId: string }
      const input = parseInput(PortalRescheduleSchema, request.body)

      return rescheduleOwnAppointment(callerOf(request), tutorId, appointmentId, input)
    },
  )

  // ─── MOD-PORTAL-08 — Extrato e Recibos ─────────────────────────────────────

  /**
   * O painel: saldo, o que está em aberto, pacotes e como pagar.
   *
   * `finance:read_own` é permissão que existe desde o MOD-IDENT e **nenhuma rota
   * exigia** — como as outras oito `_own` até a fatia 1. Aqui ela ganha a primeira.
   */
  app.get(
    '/portal/v1/finance',
    { preHandler: requirePermission('finance:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      return readOwnFinance(tenantId, tutorId)
    },
  )

  app.get(
    '/portal/v1/finance/statement',
    { preHandler: requirePermission('finance:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const query = parseInput(PortalStatementQuerySchema, request.query)

      return readOwnStatement(tenantId, tutorId, query)
    },
  )

  /**
   * AC-03 — o recibo do pagamento.
   *
   * Devolve a **URL assinada**, não os bytes: o recibo é peça contábil e já mora no
   * bucket com retenção de cinco anos, ao contrário dos relatórios do MOD-COBRANCA, que
   * são o retrato de um instante e por isso descem em bytes. O que atravessa aqui é o
   * endereço de um arquivo que já existe.
   */
  app.get(
    '/portal/v1/finance/receipts/:paymentId',
    { preHandler: requirePermission('finance:read_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const { paymentId } = request.params as { paymentId: string }
      const auth = requireTenantContext(request)

      return readOwnReceipt(
        { tenantId: auth.tenantId, clerkUserId: auth.clerkUserId, userId: auth.userId ?? undefined },
        {
          actorUserId: auth.userId,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
        tutorId,
        paymentId,
      )
    },
  )
}
