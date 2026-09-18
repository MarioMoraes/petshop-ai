import { withTenant, type TenantTransaction } from '@petshop/db'
import { AppError, type AppointmentSource } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { invalid, notFound } from './errors.js'
import { publishEvent } from '../../shared/events.js'
import { tenantOptions, type ActorContext } from '../schedule-catalog/actor.js'
import { createBooking, type BookingCapabilities } from './booking.js'
import { openCipher } from './crypto.js'

/**
 * A máquina de estado do agendamento (§6 do PRD da agenda).
 *
 * Um princípio governa o arquivo: **transição inválida é 409, não 500**. Tentar
 * fazer check-in num agendamento cancelado não é um bug do servidor — é a recepção
 * clicando num botão que a tela devia ter escondido, e a resposta certa explica o
 * estado atual em vez de estourar.
 *
 * `COMPLETED` é terminal e **não** volta atrás. Erro no fechamento se corrige por
 * estorno no MOD-LEDGER e adendo no MOD-PRONT, nunca reabrindo o atendimento:
 * reabrir desfaria um débito que o tutor talvez já tenha pago.
 */

export type AppointmentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'RESCHEDULED'

/**
 * O grafo do §6, escrito uma vez.
 *
 * Está aqui como dado, e não espalhado em `if`s pelas funções, porque é a única
 * forma de garantir que a tela, a API e o job de no-show concordem sobre o que é
 * possível. Um `if` esquecido numa das três seria descoberto em produção.
 */
const ALLOWED: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'RESCHEDULED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  RESCHEDULED: [],
}

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  PENDING: 'aguardando aprovação',
  CONFIRMED: 'confirmado',
  CHECKED_IN: 'com check-in feito',
  IN_PROGRESS: 'em atendimento',
  COMPLETED: 'concluído',
  CANCELLED: 'cancelado',
  NO_SHOW: 'marcado como falta',
  RESCHEDULED: 'remarcado',
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED[from].includes(to)
}

function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (canTransition(from, to)) return
  throw new AppError(
    'ERR_AGENDA_006',
    `Este agendamento está ${STATUS_LABELS[from]} e não pode passar para ${STATUS_LABELS[to]}`,
    undefined,
    { from, to, allowed: ALLOWED[from] },
  )
}

/** Aplica a transição e grava a linha da trilha, na mesma transação. */
async function applyTransition(
  tx: TenantTransaction,
  actor: ActorContext,
  appointmentId: string,
  from: AppointmentStatus,
  to: AppointmentStatus,
  data: Record<string, unknown> = {},
  reason?: string,
): Promise<void> {
  assertTransition(from, to)

  await tx.appointment.update({
    where: { id: appointmentId },
    data: { status: to, ...data },
  })

  await tx.appointmentStatusLog.create({
    data: {
      tenantId: actor.tenantId,
      appointmentId,
      fromStatus: from,
      toStatus: to,
      changedBy: actor.actorUserId ?? null,
      ...(reason ? { reason: reason.slice(0, 200) } : {}),
    },
  })
}

async function loadAppointment(tx: TenantTransaction, appointmentId: string) {
  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId },
    include: { items: true },
  })
  if (!appointment) throw notFound('Agendamento não encontrado')
  return appointment
}

// ─── Check-in ────────────────────────────────────────────────────────────────

/**
 * RN-17: check-in fora do horário é **permitido**. O pet está ali.
 *
 * A hora real vai para `checkin_at` e a métrica compara com `starts_at`. Recusar o
 * check-in de quem chegou atrasado não faria o pet ir embora — só deixaria a agenda
 * mentindo sobre o que aconteceu.
 */
export async function checkIn(actor: ActorContext, appointmentId: string) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const appointment = await loadAppointment(tx, appointmentId)
      const now = new Date()

      await applyTransition(
        tx,
        actor,
        appointmentId,
        appointment.status as AppointmentStatus,
        'CHECKED_IN',
        { checkinAt: now },
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'appointment.checked_in',
        entity: 'appointment',
        entityId: appointmentId,
        after: {
          checkinAt: now.toISOString(),
          scheduledFor: appointment.startsAt.toISOString(),
          // O atraso é dado de negócio: desvio persistente significa que a agenda
          // está mentindo sobre a duração real.
          delayMin: Math.round((now.getTime() - appointment.startsAt.getTime()) / 60_000),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { petId: appointment.petId, professionalId: appointment.professionalId }
    },
    tenantOptions(actor),
  )

  await publishEvent('atendimento.iniciado', {
    tenantId: actor.tenantId,
    appointmentId,
    petId: result.petId,
    professionalId: result.professionalId,
  })

  return result
}

// ─── Check-out ───────────────────────────────────────────────────────────────

export interface CheckoutInput {
  /** Convenção do MOD-LEDGER: todo POST que move dinheiro é idempotente. */
  idempotencyKey: string
  /** RN-18: serviço acrescentado durante a execução. */
  extraItems?: { serviceId: string }[]
  weightKg?: number | undefined
  notes?: string | undefined
}

/**
 * O check-out é o evento mais importante do sistema.
 *
 * É dele que nascem o débito (MOD-LEDGER), o registro clínico (MOD-PRONT-01) e o
 * `pets.last_attendance_at`. RN-05: **o débito nasce aqui**, não no agendamento nem
 * no check-in — serviço não executado não gera dívida.
 *
 * `idempotencyKey` existe porque um duplo clique no botão de fechar a conta lançaria
 * o débito duas vezes. A chave é gravada na trilha de estado, e a segunda chamada com
 * a mesma chave devolve o resultado da primeira em vez de repetir o efeito.
 */
export async function checkOut(
  actor: ActorContext,
  appointmentId: string,
  input: CheckoutInput,
) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const appointment = await loadAppointment(tx, appointmentId)

      // Idempotência: a chave já usada significa que este check-out já aconteceu.
      const previous = await tx.appointmentStatusLog.findFirst({
        where: { appointmentId, toStatus: 'COMPLETED', reason: input.idempotencyKey },
      })
      if (previous) {
        return {
          repeated: true,
          petId: appointment.petId,
          tutorId: appointment.tutorId,
          professionalId: appointment.professionalId,
          totalCents: Number(appointment.totalCents),
          source: appointment.source as AppointmentSource,
          startedAt: appointment.checkinAt ?? appointment.startsAt,
          items: appointment.items.map((item) => ({
            serviceId: item.serviceId,
            label: item.label,
            priceCents: Number(item.priceCents),
          })),
        }
      }

      let totalCents = Number(appointment.totalCents)

      // RN-18: o item extra entra com preço próprio, sem exigir novo agendamento.
      for (const extra of input.extraItems ?? []) {
        const service = await tx.service.findFirst({
          where: { id: extra.serviceId, deletedAt: null },
          select: { id: true, name: true },
        })
        if (!service) throw notFound('Serviço não encontrado')

        const pet = await tx.pet.findFirstOrThrow({
          where: { id: appointment.petId },
          select: { sizeId: true },
        })
        const pricing = await tx.servicePricing.findFirst({
          where: { serviceId: service.id, sizeId: pet.sizeId },
        })
        if (!pricing) {
          throw invalid(`O serviço "${service.name}" não tem preço para o porte deste pet`)
        }

        await tx.appointmentItem.create({
          data: {
            tenantId: actor.tenantId,
            appointmentId,
            serviceId: service.id,
            label: service.name,
            priceCents: pricing.priceCents,
            durationMin: pricing.durationMin,
            addedAtCheckout: true,
          },
        })
        totalCents += Number(pricing.priceCents)
      }

      const now = new Date()
      const cipher = input.notes ? await openCipher(tx, actor.tenantId) : null

      await applyTransition(
        tx,
        actor,
        appointmentId,
        appointment.status as AppointmentStatus,
        'COMPLETED',
        {
          checkoutAt: now,
          totalCents: BigInt(totalCents),
          ...(cipher && input.notes ? { notesEncrypted: cipher.encrypt(input.notes) } : {}),
        },
        input.idempotencyKey,
      )

      const items = await tx.appointmentItem.findMany({ where: { appointmentId } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'appointment.completed',
        entity: 'appointment',
        entityId: appointmentId,
        after: {
          checkoutAt: now.toISOString(),
          totalCents,
          items: items.map((item) => item.label),
          executedMin: Math.round(
            (now.getTime() - (appointment.checkinAt ?? appointment.startsAt).getTime()) / 60_000,
          ),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        repeated: false,
        petId: appointment.petId,
        tutorId: appointment.tutorId,
        professionalId: appointment.professionalId,
        totalCents,
        source: appointment.source as AppointmentSource,
        startedAt: appointment.checkinAt ?? appointment.startsAt,
        items: items.map((item) => ({
          serviceId: item.serviceId,
          label: item.label,
          priceCents: Number(item.priceCents),
        })),
      }
    },
    tenantOptions(actor),
  )

  // O evento sai só na primeira vez: republicá-lo lançaria o débito de novo do outro
  // lado, que é exatamente o que a chave de idempotência existe para impedir.
  if (!result.repeated) {
    await publishEvent('atendimento.concluido', {
      tenantId: actor.tenantId,
      appointmentId,
      petId: result.petId,
      tutorId: result.tutorId,
      professionalId: result.professionalId,
      items: result.items,
      totalCents: result.totalCents,
      weightKg: input.weightKg ?? null,
      // MOD-PRONT-01: o prontuário precisa distinguir o encaixe do agendado, e
      // depois que o agendamento retroativo existe na tabela a origem é o único
      // sinal que resta. `startedAt` é a hora real — o check-in, quando houve.
      origin: result.source === 'WALK_IN' ? 'WALK_IN' : 'SCHEDULED',
      startedAt: result.startedAt.toISOString(),
    })
  }

  return result
}

// ─── Cancelamento ────────────────────────────────────────────────────────────

/**
 * A base da taxa de arrependimento — o total **sem** o leva-e-traz.
 *
 * `appointments.total_cents` inclui as corridas desde o MOD-TAXI: a corrida vira um
 * `appointment_items` com `duration_min = 0` e soma no total (RN-05 do MOD-TAXI). Cobrar
 * um percentual sobre esse total cobra o tutor **pelo transporte que não vai acontecer**,
 * e o transporte já é desfeito por conta própria — a cascata de `agendamento.cancelado`
 * cancela as corridas e o `removeCharge` do taxidog-service apaga o item.
 *
 * O AC-06 de MOD-PORTAL-07 diz a regra em uma linha: não se cobra duas vezes pelo mesmo
 * arrependimento. Sem esta subtração, um banho de R$ 80 com R$ 30 de leva-e-traz e taxa
 * de 50% cobraria R$ 55 em vez de R$ 40.
 *
 * A ordem dos fatos é o que torna a subtração necessária aqui: a taxa é calculada e
 * publicada **antes** de o taxidog-service consumir o evento e devolver o valor da
 * corrida. Quando o ledger lê `feeCents`, o total ainda está inflado.
 */
async function feeBaseCents(
  tx: TenantTransaction,
  appointment: { id: string; totalCents: bigint },
): Promise<number> {
  const taxiItems = await tx.appointmentItem.findMany({
    where: { appointmentId: appointment.id, service: { category: 'TAXI' } },
    select: { priceCents: true },
  })

  const taxiCents = taxiItems.reduce((soma, item) => soma + Number(item.priceCents), 0)
  return Math.max(0, Number(appointment.totalCents) - taxiCents)
}


export interface CancelInput {
  reason?: string | undefined
  /** A recepção pode isentar a taxa do cancelamento tardio (RN-06). */
  waiveFee?: boolean
  /** RN-10 e RN-12: cancelamento por óbito ou bloqueio nunca gera taxa. */
  systemInitiated?: boolean
  /**
   * Se o tutor deve ser avisado. Ausente é `true`.
   *
   * Quem pede silêncio é o desfazer de um lote do MOD-IMPORT: ele cancela em massa
   * horários que nunca foram anunciados, porque a carga entrou calada. O lembrete
   * pendente morre de qualquer forma — quem o cancela é o mesmo consumidor, antes do
   * aviso.
   */
  notify?: boolean
}

/**
 * RN-06: abaixo da janela de cancelamento, `cancelled_late = true` e a taxa entra.
 *
 * A janela é do tenant (`cancellation_window_hours`, padrão 24h — decisão de negócio
 * 1). Quem decide se **cobra** é o MOD-LEDGER, que consome o evento; aqui só se
 * registra o fato de ter sido tardio, que é o que não dá para recalcular depois.
 */
export async function cancel(actor: ActorContext, appointmentId: string, input: CancelInput = {}) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const appointment = await loadAppointment(tx, appointmentId)

      const settings = await tx.tenantSettings.findFirst({
        where: { tenantId: actor.tenantId },
        select: { cancellationWindowHours: true, noShowFeePercent: true },
      })
      const windowHours = settings?.cancellationWindowHours ?? 24
      const now = new Date()
      const hoursAhead = (appointment.startsAt.getTime() - now.getTime()) / 3_600_000

      // Cancelamento do sistema (óbito, bloqueio) nunca é tardio: a falta não é do
      // tutor, e cobrá-lo por ela seria o pior tipo de erro de produto.
      const late = !input.systemInitiated && hoursAhead < windowHours
      const feeCents =
        late && !input.waiveFee
          ? Math.round(
              ((await feeBaseCents(tx, appointment)) * (settings?.noShowFeePercent ?? 0)) / 100,
            )
          : 0

      const cipher = input.reason ? await openCipher(tx, actor.tenantId) : null

      await applyTransition(
        tx,
        actor,
        appointmentId,
        appointment.status as AppointmentStatus,
        'CANCELLED',
        {
          cancelledAt: now,
          cancelledLate: late,
          ...(cipher && input.reason
            ? { cancelReasonEncrypted: cipher.encrypt(input.reason) }
            : {}),
        },
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'appointment.cancelled',
        entity: 'appointment',
        entityId: appointmentId,
        after: {
          late,
          feeCents,
          waived: input.waiveFee ?? false,
          systemInitiated: input.systemInitiated ?? false,
          hoursAhead: Math.round(hoursAhead),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { late, feeCents, tutorId: appointment.tutorId }
    },
    tenantOptions(actor),
  )

  await publishEvent('agendamento.cancelado', {
    tenantId: actor.tenantId,
    appointmentId,
    late: result.late,
    feeCents: result.feeCents,
    cancelledBy: actor.actorUserId ?? null,
    ...(input.notify === false ? { notify: false } : {}),
  })

  return result
}

// ─── No-show ─────────────────────────────────────────────────────────────────

/**
 * O horário venceu e ninguém apareceu.
 *
 * Separado do cancelamento de propósito: cancelar é um ato do tutor, faltar é a
 * ausência de ato. Os dois geram taxa, mas só um deles tem alguém para avisar antes.
 */
export async function markNoShow(actor: ActorContext, appointmentId: string) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const appointment = await loadAppointment(tx, appointmentId)

      const settings = await tx.tenantSettings.findFirst({
        where: { tenantId: actor.tenantId },
        select: { noShowFeePercent: true },
      })
      // A mesma base do cancelamento, e pela mesma razão: quem faltou não deve um
      // percentual sobre a corrida. Quando a coleta chegou a sair e não achou ninguém,
      // quem decide se ela se cobra é `charge_failed_pickup` do MOD-TAXI — regra que
      // olha para a corrida em si, não para a falta.
      const feeCents = Math.round(
        ((await feeBaseCents(tx, appointment)) * (settings?.noShowFeePercent ?? 0)) / 100,
      )

      await applyTransition(
        tx,
        actor,
        appointmentId,
        appointment.status as AppointmentStatus,
        'NO_SHOW',
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'appointment.no_show',
        entity: 'appointment',
        entityId: appointmentId,
        after: { feeCents, scheduledFor: appointment.startsAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { feeCents, tutorId: appointment.tutorId }
    },
    tenantOptions(actor),
  )

  await publishEvent('agendamento.no_show', {
    tenantId: actor.tenantId,
    appointmentId,
    tutorId: result.tutorId,
    feeCents: result.feeCents,
  })

  return result
}

// ─── Remarcação ──────────────────────────────────────────────────────────────

export interface RescheduleInput {
  startsAt: Date
  professionalId?: string | undefined
  reason?: string | undefined
}

/**
 * AC-04: remarcar **cria um novo agendamento** e marca o antigo como `RESCHEDULED`,
 * apontando `rescheduled_to_id`.
 *
 * Um `UPDATE` no lugar seria mais simples e destruiria a informação: "quantas vezes
 * este tutor remarcou" é dado de negócio, não ruído. O AC-05 depende exatamente
 * disso — a agenda **relata** a reincidência, e o MOD-CRM decide o que fazer com ela.
 *
 * O novo agendamento passa por `createBooking` inteiro, gates incluídos. Remarcar não
 * é editar: o horário novo precisa caber na jornada, respeitar capacidade e passar
 * pelos mesmos alertas clínicos que o original passou.
 */
export async function reschedule(
  actor: ActorContext,
  appointmentId: string,
  input: RescheduleInput,
  capabilities: BookingCapabilities = { canOverrideCredit: false },
) {
  const original = await withTenant(actor.tenantId, async (tx) => {
    const appointment = await loadAppointment(tx, appointmentId)
    // Falha cedo, antes de criar o novo: descobrir que a transição era inválida
    // depois de gravar deixaria dois agendamentos para o mesmo pet.
    assertTransition(appointment.status as AppointmentStatus, 'RESCHEDULED')
    return appointment
  })

  const created = await createBooking(
    actor,
    {
      petId: original.petId,
      professionalId: input.professionalId ?? original.professionalId,
      startsAt: input.startsAt,
      items: original.items
        .filter((item) => !item.addedAtCheckout)
        .map((item) => ({ serviceId: item.serviceId })),
      // O encaixe nunca chega aqui — ele nasce `COMPLETED`, e concluído não remarca.
      // O `STAFF` é o fallback que o compilador exige, não um caso real.
      source: original.source === 'WALK_IN' ? 'STAFF' : original.source,
      // O alerta clínico já foi reconhecido no original; exigir de novo faria a
      // recepção reconhecer duas vezes o mesmo risco para mover um horário.
      acknowledgedAlerts: original.acknowledgedAlertsAt !== null,
    },
    capabilities,
  )

  const count = await withTenant(
    actor.tenantId,
    async (tx) => {
      await applyTransition(
        tx,
        actor,
        appointmentId,
        original.status as AppointmentStatus,
        'RESCHEDULED',
        { rescheduledToId: created.id },
        input.reason,
      )

      // AC-05: quantas vezes esta mesma marcação já andou. Sobe a cadeia até a
      // origem — cada remarcação aponta para a seguinte, então o comprimento da
      // cadeia é o número de vezes.
      const rescheduleCount = await countRescheduleChain(tx, appointmentId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'appointment.rescheduled',
        entity: 'appointment',
        entityId: appointmentId,
        after: {
          newAppointmentId: created.id,
          from: original.startsAt.toISOString(),
          to: created.startsAt.toISOString(),
          rescheduleCount,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return rescheduleCount
    },
    tenantOptions(actor),
  )

  await publishEvent('agendamento.reagendado', {
    tenantId: actor.tenantId,
    appointmentId,
    newAppointmentId: created.id,
    startsAt: created.startsAt.toISOString(),
    rescheduleCount: count,
  })

  return { newAppointmentId: created.id, rescheduleCount: count }
}

/**
 * Sobe a cadeia de remarcações até a origem.
 *
 * Tem teto de segurança: uma cadeia circular — que não deveria existir, mas custa
 * pouco descartar — travaria a requisição em laço infinito.
 */
const MAX_CHAIN = 50

async function countRescheduleChain(
  tx: TenantTransaction,
  appointmentId: string,
): Promise<number> {
  let count = 1
  let current = appointmentId

  for (let i = 0; i < MAX_CHAIN; i += 1) {
    const previous = await tx.appointment.findFirst({
      where: { rescheduledToId: current },
      select: { id: true },
    })
    if (!previous) break
    count += 1
    current = previous.id
  }

  return count
}

// ─── Aprovação (MOD-AGENDA-06 AC-03) ─────────────────────────────────────────

/**
 * A recepção aprova uma solicitação do Portal.
 *
 * O horário já estava reservado desde a criação — o `PENDING` ocupa lugar na agenda
 * (está em `OCCUPYING_STATUSES`), e é isso que impede o balcão de vender por baixo o
 * horário que o tutor pediu e ainda espera resposta.
 */
export interface ApprovedBooking {
  petId: string
  tutorId: string
  professionalId: string
  startsAt: Date
  endsAt: Date
  totalCents: number
  source: 'STAFF' | 'PORTAL' | 'RECURRENCE' | 'AI_AGENT'
}

export async function approve(
  actor: ActorContext,
  appointmentId: string,
): Promise<ApprovedBooking> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const appointment = await loadAppointment(tx, appointmentId)

      await applyTransition(
        tx,
        actor,
        appointmentId,
        appointment.status as AppointmentStatus,
        'CONFIRMED',
      )

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'appointment.approved',
        entity: 'appointment',
        entityId: appointmentId,
        after: { startsAt: appointment.startsAt.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        petId: appointment.petId,
        tutorId: appointment.tutorId,
        professionalId: appointment.professionalId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        totalCents: Number(appointment.totalCents),
        source: appointment.source as ApprovedBooking['source'],
      }
    },
    tenantOptions(actor),
  )

  // Só agora sai `agendamento.criado`: é a confirmação que dispara o lembrete e a
  // mensagem ao tutor, e mandá-la na solicitação avisaria de algo que ainda podia
  // ser recusado.
  await publishEvent('agendamento.criado', {
    tenantId: actor.tenantId,
    appointmentId,
    petId: result.petId,
    tutorId: result.tutorId,
    professionalId: result.professionalId,
    startsAt: result.startsAt.toISOString(),
    endsAt: result.endsAt.toISOString(),
    totalCents: result.totalCents,
    source: result.source,
  })

  return result
}
