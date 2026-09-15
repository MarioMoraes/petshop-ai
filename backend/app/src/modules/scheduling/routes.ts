import { withTenant } from '@petshop/db'
import {
  AvailabilityQuerySchema,
  BookingSourcesQuerySchema,
  CancelAppointmentSchema,
  CheckoutSchema,
  CreateAppointmentSchema,
  CreateRecurrenceSchema,
  CreateWalkInSchema,
  DayViewQuerySchema,
  ListAppointmentsQuerySchema,
  MovementQuerySchema,
  NewPortalBookingsQuerySchema,
  NoShowReportQuerySchema,
  NOVOS_AGENDAMENTOS_JANELA_DIAS,
  RecurrenceScopeSchema,
  RescheduleSchema,
  todayIn,
  zonedDate,
  zonedMidnight,
  type AppointmentStatus,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hasPermission, requirePermission, requireTenantContext } from './auth.js'
import { parseInput } from './validate.js'
import type { ActorContext } from '../schedule-catalog/actor.js'
import { resolveAvailability } from './availability.js'
import { createBooking } from './booking.js'
import { getDayView } from './day-view.js'
import { getBookingSources, getMovement, getNoShows } from './movement.js'
import { getAppointment, listAppointments } from './queries.js'
import { createRecurrence, endRecurrence } from './recurrence.js'
import { loadTimezone } from './timezone.js'
import { createWalkIn } from './walkin.js'
import { approve, cancel, checkIn, checkOut, markNoShow, reschedule } from './transitions.js'

/**
 * Rotas do agendamento (PRD agenda_operacao_06 §5).
 *
 * A matriz do §9 dá permissões diferentes para ler, escrever e fazer check-in — e é
 * de propósito: o banhista faz check-in do pet que ele vai lavar, mas não remarca
 * nada; a recepção agenda o dia inteiro, mas não libera crédito.
 */

const IdParamSchema = z.object({ id: z.uuid() })

/**
 * Os estados em que um agendamento está, de fato, na agenda.
 *
 * É o recorte do aviso de novidade do sino, e o que ele deixa de fora explica-o
 * melhor que o que ele inclui. `PENDING` sai porque a rota de triagem já o conta, e
 * somar o mesmo agendamento em duas linhas do mesmo painel faria o sino dizer 2 para
 * uma coisa só. `CANCELLED`, `NO_SHOW` e `RESCHEDULED` saem porque o clique leva à
 * visão do dia e nenhum dos três está lá — anunciar novidade que some ao ser aberta é
 * exatamente o defeito que a marca de lido existe para evitar.
 */
const NA_AGENDA: AppointmentStatus[] = ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']

function actorFrom(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? undefined,
  }
}

const READ = { preHandler: requirePermission('schedule:read_all') }
const WRITE = { preHandler: requirePermission('schedule:write_all') }
const CHECKIN = { preHandler: requirePermission('checkin:manage') }

export async function registerSchedulingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/availability', READ, async (request) => {
    const query = parseInput(AvailabilityQuerySchema, request.query)
    return resolveAvailability(actorFrom(request).tenantId, query)
  })

  app.get('/v1/appointments', READ, async (request) => {
    const query = parseInput(ListAppointmentsQuerySchema, request.query)
    return listAppointments(actorFrom(request), query)
  })

  /**
   * A fila da triagem, para o sino do Admin (AC-06 de MOD-PORTAL-05).
   *
   * Rota de **contagem**, e não `listAppointments` com `status=PENDING`: aquela tem
   * `take: 200`, e um contador que soma uma listagem truncada mente calado a partir do
   * item 201. Aqui é `count` no banco.
   *
   * Só `source: PORTAL`. `PENDING` também nasce de uma série recorrente criada com a
   * triagem ligada, e essa foi a própria equipe que marcou — chamá-la de "pedido do
   * site" faria o sino mentir sobre a origem.
   *
   * Precisa vir **antes** de `/v1/appointments/:id`: o Fastify casa por ordem de
   * registro, e `pending-count` seria lido como um id.
   */
  app.get('/v1/appointments/pending-count', READ, async (request) => {
    const actor = actorFrom(request)

    return withTenant(actor.tenantId, async (tx) => {
      const where = { status: 'PENDING' as const, source: 'PORTAL' as const }

      const [count, proximo, timezone] = await Promise.all([
        tx.appointment.count({ where }),
        tx.appointment.findFirst({
          where,
          orderBy: { startsAt: 'asc' },
          select: { startsAt: true },
        }),
        loadTimezone(tx),
      ])

      return {
        count,
        // RN-19: o dia é o do estabelecimento. Cortar por UTC mandaria o link para
        // ontem em toda solicitação da madrugada.
        nextDate: proximo ? zonedDate(proximo.startsAt, timezone) : null,
      }
    })
  })

  /**
   * O aviso de agendamento novo pelo Portal, para o sino do Admin.
   *
   * Irmã da rota acima e o oposto dela. A de cima conta o que **espera decisão** e
   * zera quando alguém decide; esta conta o que **já está marcado** e nunca zeraria
   * sozinha — por isso é a única do sino que recebe uma marca de lido.
   *
   * A marca vem em `since` em vez de ser lida aqui: ela mora em `memberships`, que é
   * tabela do MOD-IDENT. A agenda sabe contar agendamento; quem guarda o que cada
   * pessoa já viu é o dono do vínculo.
   *
   * O recorte de estado é `NA_AGENDA`, e o que ele deixa de fora está explicado lá.
   */
  app.get('/v1/appointments/portal-new-count', READ, async (request) => {
    const { since } = parseInput(NewPortalBookingsQuerySchema, request.query)
    const actor = actorFrom(request)
    const agora = new Date()

    /*
     * O teto de novidade, e o motivo de ele existir: `since` é nulo para quem nunca
     * abriu o sino, e "desde sempre" faria a primeira abertura de um estabelecimento
     * com um ano de agenda anunciar centenas de agendamentos de uma vez.
     *
     * Vale também com marca antiga — quem voltou de férias vê a última semana, não o
     * mês inteiro. O que foi marcado há duas semanas já está na agenda, e já não é
     * notícia.
     */
    const teto = new Date(agora.getTime() - NOVOS_AGENDAMENTOS_JANELA_DIAS * 24 * 60 * 60 * 1000)
    const visto = since ? new Date(since) : null
    const desde = visto && visto > teto ? visto : teto

    return withTenant(actor.tenantId, async (tx) => {
      const where = {
        source: 'PORTAL' as const,
        createdAt: { gt: desde },
        status: { in: NA_AGENDA },
      }

      const timezone = await loadTimezone(tx)

      const [count, proximo] = await Promise.all([
        tx.appointment.count({ where }),
        /*
         * O mais próximo a partir do começo do dia **do estabelecimento**, e não a
         * partir de agora: um banho das 08h continua sendo o destino certo às 10h,
         * porque a visão do dia mostra o dia inteiro.
         */
        tx.appointment.findFirst({
          where: { ...where, startsAt: { gte: zonedMidnight(todayIn(timezone, agora), timezone) } },
          orderBy: { startsAt: 'asc' },
          select: { startsAt: true },
        }),
      ])

      return {
        count,
        nextDate: proximo ? zonedDate(proximo.startsAt, timezone) : null,
      }
    })
  })

  app.get('/v1/appointments/:id', READ, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    return getAppointment(actorFrom(request), id)
  })

  app.post('/v1/appointments', WRITE, async (request, reply) => {
    const input = parseInput(CreateAppointmentSchema, request.body)

    const booking = await createBooking(
      actorFrom(request),
      {
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt: new Date(input.startsAt),
        items: input.items,
        notes: input.notes,
        source: input.source,
        acknowledgedAlerts: input.acknowledgedAlerts,
        override: input.override,
      },
      // A capacidade vem da matriz de permissão, não do papel: repetir "é
      // TENANT_ADMIN?" aqui criaria uma segunda fonte de verdade sobre RBAC.
      { canOverrideCredit: hasPermission(request, 'schedule:override_credit') },
    )

    return reply.status(201).send(await getAppointment(actorFrom(request), booking.id))
  })

  /**
   * O encaixe. `checkin:manage` e não `schedule:write_all` de propósito: quem
   * registra um pet que já foi atendido é a mesma pessoa que faz o check-out, e
   * exigir a permissão de agendar deixaria o banhista sem caminho para fechar o
   * atendimento que ele mesmo executou.
   */
  app.post('/v1/appointments/walk-in', CHECKIN, async (request, reply) => {
    const input = parseInput(CreateWalkInSchema, request.body)
    const { id } = await createWalkIn(actorFrom(request), input)
    return reply.status(201).send(await getAppointment(actorFrom(request), id))
  })

  app.post('/v1/appointments/:id/checkin', CHECKIN, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await checkIn(actorFrom(request), id)
    return getAppointment(actorFrom(request), id)
  })

  app.post('/v1/appointments/:id/checkout', CHECKIN, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(CheckoutSchema, request.body)
    await checkOut(actorFrom(request), id, input)
    return getAppointment(actorFrom(request), id)
  })

  app.post('/v1/appointments/:id/cancel', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(CancelAppointmentSchema, request.body)
    await cancel(actorFrom(request), id, input)
    return getAppointment(actorFrom(request), id)
  })

  /**
   * Marcar falta é ato de gestão, não de atendimento: quem faz check-in não decide
   * que alguém faltou. O job `no-show-sweeper` chama o mesmo caminho.
   */
  app.post('/v1/appointments/:id/no-show', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await markNoShow(actorFrom(request), id)
    return getAppointment(actorFrom(request), id)
  })

  /**
   * AC-04 de MOD-AGENDA-08. Devolve o **novo** agendamento: é para ele que a tela
   * navega, e o antigo já é histórico no instante da resposta.
   */
  app.post('/v1/appointments/:id/reschedule', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const input = parseInput(RescheduleSchema, request.body)

    const result = await reschedule(
      actorFrom(request),
      id,
      {
        startsAt: new Date(input.startsAt),
        professionalId: input.professionalId,
        reason: input.reason,
      },
      { canOverrideCredit: hasPermission(request, 'schedule:override_credit') },
    )

    return {
      ...(await getAppointment(actorFrom(request), result.newAppointmentId)),
      rescheduleCount: result.rescheduleCount,
    }
  })

  /** AC-03 de MOD-AGENDA-06: a recepção decide a fila do Portal. */
  app.post('/v1/appointments/:id/approve', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await approve(actorFrom(request), id)
    return getAppointment(actorFrom(request), id)
  })

  // ─── Visão do dia (MOD-AGENDA-09) ────────────────────────────────────────

  app.get('/v1/agenda/day', READ, async (request) => {
    const query = parseInput(DayViewQuerySchema, request.query)
    const actor = actorFrom(request)

    // RN-19: o fuso é do tenant. "Hoje" em Manaus não é "hoje" em São Paulo.
    const timezone = await withTenant(actor.tenantId, loadTimezone)

    return getDayView(actor, query.date, timezone)
  })

  /**
   * A série do painel: quantos atendimentos por dia nos últimos `days` dias.
   *
   * Sem `date`, o último dia da janela é **hoje no fuso do tenant** — a mesma conta
   * que a visão do dia faz, e não a data do relógio do servidor.
   */
  app.get('/v1/agenda/movement', READ, async (request) => {
    const query = parseInput(MovementQuerySchema, request.query)
    const actor = actorFrom(request)

    const timezone = await withTenant(actor.tenantId, loadTimezone)

    return getMovement(actor, query.date ?? todayIn(timezone), query.days, timezone)
  })

  /**
   * A fatia do Portal nos agendamentos do período — o KPI que o PRD-mãe §11 escolheu
   * para a fase do Portal.
   *
   * `tenant:configure`, e não o `schedule:read_all` da série acima. As duas leituras
   * saem da mesma tabela e respondem a perguntas de gente diferente: a série é da
   * recepção, que quer saber como está o dia; a proporção é de quem ligou o Portal e
   * quer saber se ligá-lo valeu. O gate é o mesmo que liga e desliga o módulo.
   */
  app.get(
    '/v1/agenda/reports/booking-sources',
    { preHandler: requirePermission('tenant:configure') },
    async (request) => {
      const actor = actorFrom(request)
      const query = parseInput(BookingSourcesQuerySchema, request.query)
      return getBookingSources(actor.tenantId, query.days)
    },
  )

  /**
   * As faltas do período e o valor que ficou sem faturar.
   *
   * `tenant:configure`, como a origem dos agendamentos: o número serve para decidir
   * ligar a multa por falta, e quem liga é quem configura o estabelecimento.
   */
  app.get(
    '/v1/agenda/reports/no-shows',
    { preHandler: requirePermission('tenant:configure') },
    async (request) => {
      const actor = actorFrom(request)
      const query = parseInput(NoShowReportQuerySchema, request.query)
      return getNoShows(actor.tenantId, query.days)
    },
  )

  // ─── Recorrência (MOD-AGENDA-05) ─────────────────────────────────────────

  app.post('/v1/recurrences', WRITE, async (request, reply) => {
    const input = parseInput(CreateRecurrenceSchema, request.body)
    const result = await createRecurrence(actorFrom(request), {
      petId: input.petId,
      professionalId: input.professionalId,
      serviceIds: input.serviceIds,
      startsAt: new Date(input.startsAt),
      rrule: input.rrule,
      until: input.until ? new Date(input.until) : undefined,
    })
    return reply.status(201).send(result)
  })

  app.delete('/v1/recurrences/:id', WRITE, async (request) => {
    const { id } = parseInput(IdParamSchema, request.params)
    const scope = parseInput(
      z.object({ scope: RecurrenceScopeSchema.default('THIS_AND_FUTURE') }),
      request.query,
    )
    return endRecurrence(actorFrom(request), id, scope.scope)
  })
}
