import { withTenant, type TenantTransaction } from '@petshop/db'
import type {
  PortalAppointment,
  PortalAppointmentActions,
  PortalAppointmentDetail,
  PortalAppointmentsQuery,
  PortalAppointmentsResponse,
  PortalCancelInput,
  PortalRescheduleInput,
} from '@petshop/shared-types'
import { AppError, formatBRL } from '@petshop/shared-types'
import { invalidState, notFound } from '../../lib/errors.js'
import { assertOnlineBooking } from './booking.js'
import { getSchedulingPort, type SchedulingCaller } from './scheduling-port.js'

/**
 * MOD-PORTAL-06 — os agendamentos do tutor.
 *
 * A leitura é do BFF, direto no banco e recortada por `tutorId`, como o resto da fatia
 * 2. A escrita — cancelar, remarcar — é do scheduling-service, porque é onde a máquina
 * de estado vive; repetir aqui "de CONFIRMED pode ir para CANCELLED" seria manter duas
 * versões da mesma regra.
 *
 * O que o BFF acrescenta às duas escritas é o que o tutor precisa saber **antes**: a
 * taxa do cancelamento tardio (AC-03) e a razão pela qual um botão não aparece. Nada
 * disso é decidido pela tela: `actions` chega pronto do servidor, porque a janela de
 * cancelamento é configuração do petshop e muda sem que ninguém atualize o front.
 */

/** Ainda vai acontecer. Cancelado, concluído e faltou pertencem ao passado. */
const UPCOMING_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] as const

/** Estados que o tutor ainda pode desmarcar sozinho (AC-05). */
const CANCELLABLE_STATUSES = ['PENDING', 'CONFIRMED'] as const

const appointmentSelect = {
  id: true,
  status: true,
  source: true,
  startsAt: true,
  endsAt: true,
  totalCents: true,
  cancelledAt: true,
  cancelledLate: true,
  petId: true,
  pet: { select: { name: true } },
  professional: { select: { displayName: true } },
  items: { select: { serviceId: true, label: true } },
} as const

type AppointmentRow = {
  id: string
  status: string
  source: string
  startsAt: Date
  endsAt: Date
  totalCents: bigint
  cancelledAt: Date | null
  cancelledLate: boolean | null
  petId: string
  pet: { name: string }
  professional: { displayName: string }
  items: { serviceId: string; label: string }[]
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * AC-01 — os próximos e os passados, numa resposta só.
 *
 * Os dois juntos, e não duas rotas: a tela é uma lista com duas seções, e o tutor típico
 * tem dois ou três agendamentos futuros. Duas requisições de celular para montar uma
 * tela custam mais do que a resposta inteira.
 *
 * Só o passado é paginado. O futuro é finito por natureza — quem tem trinta
 * agendamentos marcados não existe —, e cortá-lo esconderia o de dezembro.
 */
export async function listOwnAppointments(
  tenantId: string,
  tutorId: string,
  query: PortalAppointmentsQuery,
): Promise<PortalAppointmentsResponse> {
  return withTenant(tenantId, async (tx) => {
    const now = new Date()

    const upcoming = await tx.appointment.findMany({
      where: { tutorId, startsAt: { gte: now }, status: { in: [...UPCOMING_STATUSES] } },
      orderBy: { startsAt: 'asc' },
      select: appointmentSelect,
    })

    /**
     * O cursor é a hora de início do último item entregue, e a página seguinte pega o
     * que começou **antes** dele. Passado é ordenado do mais recente para o mais
     * antigo, então o cursor anda para trás no tempo.
     */
    const cursor = query.cursor ? new Date(query.cursor) : null
    const past = await tx.appointment.findMany({
      where: {
        tutorId,
        OR: [{ startsAt: { lt: now } }, { status: { notIn: [...UPCOMING_STATUSES] } }],
        ...(cursor && !Number.isNaN(cursor.getTime()) ? { startsAt: { lt: cursor } } : {}),
      },
      orderBy: { startsAt: 'desc' },
      take: query.limit + 1,
      select: appointmentSelect,
    })

    const page = past.slice(0, query.limit)
    const nextCursor =
      past.length > query.limit ? (page.at(-1)?.startsAt.toISOString() ?? null) : null

    const [policy, settings] = await Promise.all([
      readCancellationPolicy(tx, tenantId),
      tx.tenantSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    ])

    return {
      upcoming: upcoming.map((appointment) => ({
        ...toSummary(appointment),
        actions: actionsFor(appointment, policy),
      })),
      past: page.map(toSummary),
      nextCursor,
      timezone: settings?.timezone ?? 'America/Sao_Paulo',
    }
  })
}

export async function readOwnAppointment(
  tenantId: string,
  tutorId: string,
  appointmentId: string,
): Promise<PortalAppointmentDetail> {
  return withTenant(tenantId, async (tx) => {
    const appointment = await findOwn(tx, tutorId, appointmentId)
    const policy = await readCancellationPolicy(tx, tenantId)

    return {
      ...toSummary(appointment),
      source: appointment.source,
      serviceIds: appointment.items.map((item) => item.serviceId),
      cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
      cancelledLate: appointment.cancelledLate,
      actions: actionsFor(appointment, policy),
    }
  })
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

/**
 * AC-02 e AC-03 — o cancelamento.
 *
 * A taxa é calculada aqui **antes** de chamar o domínio, e a primeira tentativa sem
 * `acknowledgeFee` é recusada com o valor no corpo. Não é burocracia: quem cancela
 * pelo celular na véspera não tem atendente para avisar que vai ser cobrado, e uma
 * cobrança que aparece depois no extrato é a pior forma de descobrir a regra.
 *
 * Com `no_show_fee_percent` em zero não há taxa e nada disso acontece — o cancelamento
 * tardio passa de primeira, que é o comportamento certo para quem não cobra.
 */
export async function cancelOwnAppointment(
  caller: SchedulingCaller,
  tutorId: string,
  appointmentId: string,
  input: PortalCancelInput,
): Promise<PortalAppointmentDetail> {
  const { appointment, policy } = await withTenant(caller.tenantId, async (tx) => {
    const found = await findOwn(tx, tutorId, appointmentId)
    return { appointment: found, policy: await readCancellationPolicy(tx, caller.tenantId) }
  })

  const actions = actionsFor(appointment, policy)

  if (!actions.canCancel) throw cannotChange(appointment.status)

  if (actions.cancelIsLate && actions.cancelFeeCents > 0 && !input.acknowledgeFee) {
    throw new AppError(
      'ERR_PORTAL_011',
      `Faltam menos de ${policy.windowHours}h para o horário. Cancelar agora gera uma taxa de ${formatBRL(actions.cancelFeeCents)}.`,
      undefined,
      {
        feeCents: actions.cancelFeeCents,
        cancellationWindowHours: policy.windowHours,
        requiresFeeAcknowledgement: true,
      },
    )
  }

  await getSchedulingPort().cancel(caller, appointmentId)
  return readOwnAppointment(caller.tenantId, tutorId, appointmentId)
}

/**
 * AC-04 — remarcar.
 *
 * Passa pelo mesmo caminho da criação do lado do domínio: disponibilidade real,
 * antecedência mínima e gates, com o preço **recalculado** para a nova data. O
 * agendamento anterior vai a `RESCHEDULED` e a resposta é o novo — é para ele que a
 * tela navega, e o antigo já é histórico no instante da resposta.
 *
 * Exige agendamento online ligado: remarcar é marcar de novo, e o petshop que fechou a
 * porta não a quer aberta pelo outro lado.
 */
export async function rescheduleOwnAppointment(
  caller: SchedulingCaller,
  tutorId: string,
  appointmentId: string,
  input: PortalRescheduleInput,
): Promise<PortalAppointmentDetail> {
  const appointment = await withTenant(caller.tenantId, async (tx) => {
    await assertOnlineBooking(tx, caller.tenantId)
    return findOwn(tx, tutorId, appointmentId)
  })

  if (!CANCELLABLE_STATUSES.includes(appointment.status as 'PENDING')) {
    throw cannotChange(appointment.status)
  }

  const created = await getSchedulingPort().reschedule(caller, appointmentId, {
    startsAt: input.startsAt,
    professionalId: input.professionalId,
  })

  return readOwnAppointment(caller.tenantId, tutorId, created.id)
}

// ─── Peças internas ──────────────────────────────────────────────────────────

/**
 * O agendamento **deste** tutor.
 *
 * O recorte é `tutorId` na consulta, e não uma comparação depois de ler: o que não é
 * dele responde 404 exatamente como o que não existe (RN-03).
 */
async function findOwn(
  tx: TenantTransaction,
  tutorId: string,
  appointmentId: string,
): Promise<AppointmentRow> {
  const found = await tx.appointment.findFirst({
    where: { id: appointmentId, tutorId },
    select: appointmentSelect,
  })
  if (!found) throw notFound('Agendamento não encontrado')
  return found as AppointmentRow
}

interface CancellationPolicy {
  windowHours: number
  feePercent: number
}

async function readCancellationPolicy(
  tx: TenantTransaction,
  tenantId: string,
): Promise<CancellationPolicy> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { cancellationWindowHours: true, noShowFeePercent: true },
  })
  return {
    windowHours: settings?.cancellationWindowHours ?? 24,
    feePercent: settings?.noShowFeePercent ?? 0,
  }
}

/**
 * O que dá para fazer com este agendamento, e quanto custa.
 *
 * A conta da taxa é a **mesma** do `cancel` do scheduling-service: percentual sobre o
 * total congelado, arredondado. Duplicá-la aqui é o preço de mostrar o valor antes de
 * cancelar — a alternativa seria uma rota de simulação no domínio, que devolveria este
 * número e nada mais. Se a fórmula mudar lá, muda aqui: as duas citam o RN-06.
 */
function actionsFor(
  appointment: AppointmentRow,
  policy: CancellationPolicy,
): PortalAppointmentActions {
  const cancellable = CANCELLABLE_STATUSES.includes(appointment.status as 'PENDING')
  const hoursAhead = (appointment.startsAt.getTime() - Date.now()) / 3_600_000
  const late = cancellable && hoursAhead < policy.windowHours

  return {
    canCancel: cancellable,
    canReschedule: cancellable,
    cancelIsLate: late,
    cancelFeeCents: late
      ? Math.round((Number(appointment.totalCents) * policy.feePercent) / 100)
      : 0,
    cancellationWindowHours: policy.windowHours,
  }
}

/** AC-05: o pet já está no petshop, e a explicação precisa dizer isso. */
function cannotChange(status: string): AppError {
  if (status === 'CHECKED_IN' || status === 'IN_PROGRESS') {
    return invalidState('Seu pet já está no petshop. Fale com a equipe para resolver.')
  }
  if (status === 'CANCELLED') return invalidState('Este agendamento já foi cancelado.')
  if (status === 'COMPLETED') return invalidState('Este atendimento já foi concluído.')
  return invalidState('Este agendamento não pode mais ser alterado pelo site.')
}

function toSummary(appointment: AppointmentRow): PortalAppointment {
  return {
    id: appointment.id,
    status: appointment.status,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    petId: appointment.petId,
    petName: appointment.pet.name,
    professionalName: appointment.professional.displayName,
    services: appointment.items.map((item) => item.label),
    totalCents: Number(appointment.totalCents),
    awaitingApproval: appointment.status === 'PENDING',
  }
}
