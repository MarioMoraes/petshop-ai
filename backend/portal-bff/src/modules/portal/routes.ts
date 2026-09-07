import { withTenant } from '@petshop/db'
import {
  PortalAppointmentsQuerySchema,
  PortalAvailabilityQuerySchema,
  PortalBookingSchema,
  PortalCancelSchema,
  PortalAddressInputSchema,
  PortalChallengeSchema,
  PortalContactChangeSchema,
  PortalContactVerifySchema,
  PortalDeletionRequestInputSchema,
  PortalMessagesQuerySchema,
  PortalRescheduleSchema,
  PortalStatementQuerySchema,
  PortalTimelineQuerySchema,
  PortalVerifySchema,
  TermKindSchema,
  UpdateOwnPetSchema,
  UpdateOwnTutorSchema,
  UpdatePortalAddressSchema,
  UpdatePortalPreferenceSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
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
import {
  downloadOwnStatementPdf,
  readOwnFinance,
  readOwnReceipt,
  readOwnStatement,
} from './finance.js'
import { acceptOwnTerm, listOwnDocuments, listOwnTerms, readOwnDocument } from './documents.js'
import { requestContactChange, verifyContactChange } from './contact-change.js'
import { readPortalContext, readPortalTenant, touchLastSeen } from './me.js'
import {
  addOwnAddress,
  readOwnData,
  requestOwnDeletion,
  updateOwnAddress,
  updateOwnProfile,
} from './me-data.js'
import { exportOwnDataPdf } from './me-export.js'
import { listOwnMessages } from './messages.js'
import { listOwnPets, readOwnPet, updateOwnPet } from './pets.js'
import { readOwnPreferences, updateOwnPreference } from './preferences.js'
import { readTaxiOffer } from './taxi.js'
import { getTutorPort, type TutorCaller } from './tutor-port.js'
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

/**
 * Quem o BFF diz ser ao **escrever** na ficha, pela porta do tutor-service.
 *
 * Difere de `callerOf` em duas coisas, e as duas são prova e não log: o IP e o user agent
 * viajam junto, porque `tutor_consents` e `data_deletion_requests` os guardam como
 * evidência de quem consentiu e de quem pediu. Sem eles, a linha registraria o endereço do
 * contêiner do BFF — uma prova que aponta para nós mesmos.
 */
const DocumentParamSchema = z.object({ documentId: z.uuid() })
const TermParamSchema = z.object({ kind: TermKindSchema })

function tutorCallerOf(request: FastifyRequest): TutorCaller {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    clerkUserId: auth.clerkUserId,
    userId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
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
   * AC-02 de MOD-DOC-09 — o mesmo extrato, em papel.
   *
   * Bytes, e não URL assinada: o extrato não é arquivado (AC-04), então não há endereço
   * a assinar. É a mesma embalagem da exportação de dados do MOD-PORTAL-09.
   *
   * `finance:read_own`, e o recorte de titularidade vem do `ownScope` — nunca de uma
   * conferência dentro do handler.
   */
  app.get(
    '/portal/v1/finance/statement/pdf',
    { preHandler: requirePermission('finance:read_own') },
    async (request, reply) => {
      const auth = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)

      const documento = await downloadOwnStatementPdf(
        { tenantId: auth.tenantId, clerkUserId: auth.clerkUserId, userId: auth.userId ?? undefined },
        {
          actorUserId: auth.userId,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
        tutorId,
      )

      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${documento.filename}"`)
        // O extrato lista o que o titular deve e a quem: nem o navegador nem nenhum
        // intermediário tem por que guardar uma cópia.
        .header('cache-control', 'no-store')
        .send(documento.bytes)
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

  // ─── MOD-PORTAL-09 — Meus Dados ────────────────────────────────────────────

  /**
   * A ficha, como o titular a vê.
   *
   * `tutor:read_own`, a mesma permissão das preferências: é a ficha do tutor, e não um
   * módulo à parte. O recorte do que desce está em `me-data.ts`.
   */
  app.get(
    '/portal/v1/me/data',
    { preHandler: requirePermission('tutor:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      return readOwnData(tenantId, tutorId)
    },
  )

  /**
   * AC-01 e AC-03 — o que o tutor muda sozinho.
   *
   * O 422 de CPF, de nome civil, de telefone e de e-mail nasce do `UpdateOwnTutorSchema`,
   * aqui no `parseInput`: o schema é `.strict()` e declara dois campos. É o mesmo desenho
   * dos campos travados do MOD-PORTAL-03 — a trava é o contrato, não uma checagem que a
   * próxima rota possa esquecer de repetir.
   */
  app.patch(
    '/portal/v1/me/data',
    { preHandler: requirePermission('tutor:update_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const patch = parseInput(UpdateOwnTutorSchema, request.body)
      return updateOwnProfile(tutorCallerOf(request), tutorId, patch)
    },
  )

  app.post(
    '/portal/v1/me/addresses',
    { preHandler: requirePermission('tutor:update_own') },
    async (request, reply) => {
      const { tutorId } = requireOwnScope(request)
      const input = parseInput(PortalAddressInputSchema, request.body)
      const data = await addOwnAddress(tutorCallerOf(request), tutorId, input)
      return reply.status(201).send(data)
    },
  )

  /** AC-01 — mudar de casa. O endereço novo não altera corrida de taxi já criada. */
  app.patch(
    '/portal/v1/me/addresses/:addressId',
    { preHandler: requirePermission('tutor:update_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const { addressId } = request.params as { addressId: string }
      const patch = parseInput(UpdatePortalAddressSchema, request.body)
      return updateOwnAddress(tutorCallerOf(request), tutorId, addressId, patch)
    },
  )

  /**
   * AC-02 — pedir o código que confirma um telefone ou e-mail novo.
   *
   * **202, e não 201.** O que a rota promete é que o código saiu, e o envio é assíncrono:
   * um 201 diria que existe um recurso pronto para consultar, e o único recurso é um
   * desafio que a pessoa nem sabe se recebeu.
   */
  app.post(
    '/portal/v1/me/contact',
    { preHandler: requirePermission('tutor:update_own') },
    async (request, reply) => {
      const { tutorId } = requireOwnScope(request)
      const input = parseInput(PortalContactChangeSchema, request.body)

      const response = await requestContactChange({
        actor: actorOf(request),
        caller: tutorCallerOf(request),
        tutorId,
        input,
      })
      return reply.status(202).send(response)
    },
  )

  /** AC-02 — o código confere: só agora o contato entra na ficha. */
  app.post(
    '/portal/v1/me/contact/verify',
    { preHandler: requirePermission('tutor:update_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      const input = parseInput(PortalContactVerifySchema, request.body)

      return verifyContactChange({
        actor: actorOf(request),
        caller: tutorCallerOf(request),
        tutorId,
        input,
      })
    },
  )

  /**
   * AC-04 — baixar os próprios dados (LGPD art. 18, direito de acesso).
   *
   * **É o primeiro autoatendimento desse direito no sistema.** O
   * `GET /v1/tutors/:id/export` existe desde o MOD-TUTOR, mas dependia de alguém da equipe
   * rodá-lo a pedido; aqui o titular o alcança sozinho, escopado à própria ficha.
   *
   * Passa pela porta, e não por consulta ao banco, porque a exportação **audita a própria
   * leitura** (`tutor.exported`) — e é essa linha que prova, depois, que o direito foi
   * exercido e quando.
   */
  app.get(
    '/portal/v1/me/export',
    { preHandler: requirePermission('tutor:read_own') },
    async (request) => {
      const { tutorId } = requireOwnScope(request)
      return getTutorPort().exportOwnData(tutorCallerOf(request), tutorId)
    },
  )

  /**
   * AC-04, a mesma exportação **em papel**.
   *
   * O JSON acima continua sendo a portabilidade do art. 19 — formato estruturado, de
   * leitura por máquina, o arquivo que outro fornecedor importa. Esta rota existe porque
   * quem clica no Portal é gente: um JSON aberto no celular é ilegível para quem pediu
   * "meus dados", e um direito que a pessoa não consegue ler é meio direito.
   *
   * Não é `Accept: application/pdf` na rota de cima: o navegador do tutor chega aqui por
   * um `<a href download>`, e um link não escolhe header. O sufixo é o que o link sabe
   * dizer.
   *
   * Mesma permissão, mesma porta, mesma trilha — muda a embalagem, não o direito.
   */
  app.get(
    '/portal/v1/me/export/pdf',
    { preHandler: requirePermission('tutor:read_own') },
    async (request, reply) => {
      const { tutorId } = requireOwnScope(request)
      const documento = await exportOwnDataPdf(tutorCallerOf(request), tutorId)

      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${documento.filename}"`)
        // A folha é o cadastro inteiro do titular, com documento e endereço em claro.
        // Nem o navegador nem nenhum intermediário tem por que guardar uma cópia.
        .header('cache-control', 'no-store')
        .send(documento.pdf)
    },
  )

  /**
   * AC-05 — o pedido de exclusão dos dados (LGPD art. 18, V).
   *
   * **Registra, não executa.** A anonimização apaga a ficha de quem pode ter débito aberto
   * e obrigação fiscal de guarda, e a decisão é de gente. O que esta rota garante é que o
   * pedido chega a uma fila que alguém vê, com o prazo do art. 19 correndo à vista.
   *
   * `tutor:update_own` e não uma permissão de exclusão: o titular não está apagando nada,
   * está escrevendo um pedido na própria ficha.
   */
  app.post(
    '/portal/v1/me/deletion-request',
    { preHandler: requirePermission('tutor:update_own') },
    async (request, reply) => {
      const { tutorId } = requireOwnScope(request)
      const input = parseInput(PortalDeletionRequestInputSchema, request.body ?? {})

      const data = await requestOwnDeletion(tutorCallerOf(request), tutorId, input)
      return reply.status(201).send(data)
    },
  )

  // ─── MOD-PORTAL-10 — Central de Comunicação e Preferências ─────────────────

  /**
   * AC-01 — o que o petshop me mandou.
   *
   * `crm:read_own` é permissão nova, e não um recorte de `crm:read`: aquela abre também
   * o painel de entregas, com a fila e o que foi bloqueado por consentimento. O sufixo
   * `_own` é o que faz `requireOwnScope` existir nesta rota.
   */
  app.get(
    '/portal/v1/messages',
    { preHandler: requirePermission('crm:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const query = parseInput(PortalMessagesQuerySchema, request.query)

      return listOwnMessages(tenantId, tutorId, query)
    },
  )

  /**
   * AC-03 — as preferências de comunicação.
   *
   * Governadas por `tutor:read_own` e `tutor:update_own`, que o papel `TUTOR` já tinha:
   * consentimento é dado da ficha dele, e não do módulo de mensageria. É por isso que a
   * leitura da lista de mensagens e a desta pergunta passam por gates diferentes.
   */
  app.get(
    '/portal/v1/preferences',
    { preHandler: requirePermission('tutor:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      return readOwnPreferences(tenantId, tutorId)
    },
  )

  /**
   * AC-04 — ligar e desligar três vezes são três linhas, nenhuma alterada.
   *
   * `PATCH` e não `PUT`: o corpo carrega **um** canal, e o outro fica como estava. Um
   * PUT com o par inteiro faria o interruptor de e-mail gravar uma transição de
   * WhatsApp a cada toque, e a trilha jurídica registraria decisões que ninguém tomou.
   */
  app.patch(
    '/portal/v1/preferences',
    { preHandler: requirePermission('tutor:update_own') },
    async (request) => {
      const auth = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const input = parseInput(UpdatePortalPreferenceSchema, request.body)

      return updateOwnPreference(
        {
          tenantId: auth.tenantId,
          clerkUserId: auth.clerkUserId,
          userId: auth.userId ?? undefined,
          // A prova do consentimento é do tutor, não do contêiner do BFF.
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
        tutorId,
        input,
      )
    },
  )

  // ─── MOD-DOC-10 — Meus Documentos ──────────────────────────────────────────

  /**
   * A lista de documentos do titular.
   *
   * `tutor:read_own` e não `finance:read_own`: a lista atravessa recibo, receituário e
   * termo, e o que ela tem em comum não é dinheiro — é ser **do titular**. Gate
   * financeiro aqui esconderia o termo que ele assinou de quem não vê a conta.
   *
   * Nenhuma URL é assinada na listagem: abrir a lista não é baixar dez arquivos.
   */
  app.get(
    '/portal/v1/documents',
    { preHandler: requirePermission('tutor:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)

      return { documents: await listOwnDocuments(tenantId, tutorId) }
    },
  )

  /**
   * O endereço de um documento — e pedi-lo **é** o download (§9).
   *
   * AC-02: documento de outro titular responde 404, como o que não existe. O recorte é
   * `tutorId` na consulta, e o `ownScope` é quem o fornece.
   */
  app.get(
    '/portal/v1/documents/:documentId',
    { preHandler: requirePermission('tutor:read_own') },
    async (request) => {
      const auth = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)
      const { documentId } = parseInput(DocumentParamSchema, request.params)

      return readOwnDocument(auth.tenantId, tutorId, documentId, {
        actorUserId: auth.userId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      })
    },
  )

  // ─── MOD-DOC-07 e 08 — os termos, do lado do cliente ───────────────────────

  /**
   * Os termos vigentes e o que este titular já aceitou.
   *
   * `tutor:read_own`: o texto do termo é público para quem o assina, e o estado do
   * aceite é da ficha dele.
   */
  app.get(
    '/portal/v1/terms',
    { preHandler: requirePermission('tutor:read_own') },
    async (request) => {
      const { tenantId } = requireTenantContext(request)
      const { tutorId } = requireOwnScope(request)

      return { terms: await listOwnTerms(tenantId, tutorId) }
    },
  )

  /**
   * O aceite (AC-02 de MOD-DOC-07).
   *
   * `tutor:update_own`, como toda escrita do titular na própria ficha. O que grava é o
   * tutor-service, pela porta que assina — é ele que confere a versão vigente, escreve a
   * linha append-only com o IP que veio nos headers e emite o papel.
   */
  app.post(
    '/portal/v1/terms/:kind/accept',
    { preHandler: requirePermission('tutor:update_own') },
    async (request, reply) => {
      const { tutorId } = requireOwnScope(request)
      const { kind } = parseInput(TermParamSchema, request.params)

      await acceptOwnTerm(tutorCallerOf(request), tutorId, kind)
      return reply.status(204).send()
    },
  )
}
