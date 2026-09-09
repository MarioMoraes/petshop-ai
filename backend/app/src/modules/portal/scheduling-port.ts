import {
  AvailabilityQuerySchema,
  CancelAppointmentSchema,
  CreateAppointmentSchema,
  RescheduleSchema,
  type AppointmentResponse,
  type AvailabilityResponse,
} from '@petshop/shared-types'
import { resolveAvailability } from '../scheduling/availability.js'
import { createBooking } from '../scheduling/booking.js'
import { getAppointment } from '../scheduling/queries.js'
import { cancel, reschedule } from '../scheduling/transitions.js'
import type { ActorContext } from '../schedule-catalog/actor.js'

/**
 * A porta para o MOD-AGENDA.
 *
 * Era um salto HTTP com contexto assinado. Virou chamada de função na fatia 11, e a linha
 * de corte continua onde estava: **ler é escolher um recorte, agendar é aplicar regra**. A
 * criação do agendamento tem transação `SERIALIZABLE` na janela do profissional, três
 * gates, preço congelado, evento e auditoria — reimplementar isso aqui produziria uma
 * segunda agenda, que divergiria da primeira no dia em que uma das duas mudasse. O §5 do
 * PRD já dizia: o Portal **agrega**, quem valida é o módulo de domínio.
 *
 * **A elevação de permissão continua real, e continua curta.** O papel `TUTOR` não tem
 * `schedule:write_all`; estas quatro operações acontecem como se tivesse. O que as contém:
 *
 * 1. quem chama já provou a posse — o pet e o agendamento foram carregados pelo escopo
 *    `_own` antes de qualquer chamada daqui;
 * 2. `canOverrideCredit` é **sempre falso**, e é o que garante o AC-05: o devedor não
 *    libera a própria exceção. Era `schedule:override_credit` nunca assinado; hoje é uma
 *    constante, conferível na leitura;
 * 3. o ator carrega o `userId` do tutor — a auditoria grava quem realmente marcou.
 *
 * **O erro do domínio atravessa com o código original** (§5), e agora sem intermediário: o
 * `AppError` do MOD-AGENDA sobe direto. Quem reescreve a mensagem para linguagem de cliente
 * continua sendo o chamador, em `booking.ts` — "ERR_AGENDA_007" com o texto do balcão manda
 * o tutor procurar um atendente, que é exatamente o que o módulo existe para evitar.
 */

export interface SchedulingCaller {
  tenantId: string
  clerkUserId: string
  userId?: string | undefined
}

export interface AvailabilityRequest {
  petId: string
  serviceIds: string[]
  from: string
  to: string
}

export interface CreateAppointmentRequest {
  petId: string
  professionalId: string
  startsAt: string
  serviceIds: string[]
  notes?: string | undefined
  acknowledgedAlerts: boolean
}

export interface RescheduleRequest {
  startsAt: string
  professionalId: string
}

export interface SchedulingPort {
  availability(caller: SchedulingCaller, input: AvailabilityRequest): Promise<AvailabilityResponse>
  create(caller: SchedulingCaller, input: CreateAppointmentRequest): Promise<AppointmentResponse>
  cancel(caller: SchedulingCaller, appointmentId: string): Promise<AppointmentResponse>
  reschedule(
    caller: SchedulingCaller,
    appointmentId: string,
    input: RescheduleRequest,
  ): Promise<AppointmentResponse>
}

/** O ator que o MOD-AGENDA recebe, montado do chamador do Portal. */
function actorOf(caller: SchedulingCaller): ActorContext {
  return { tenantId: caller.tenantId, actorUserId: caller.userId }
}

/**
 * Nenhuma das quatro libera crédito.
 *
 * Vale para `create` e para `reschedule`: remarcar reabre o gate de inadimplência, e um
 * devedor que empurra o banho para a semana que vem não pode se autoisentar no caminho.
 */
const SEM_OVERRIDE = { canOverrideCredit: false } as const

function createInProcessPort(): SchedulingPort {
  return {
    availability(caller, input) {
      const query = AvailabilityQuerySchema.parse({
        petId: input.petId,
        // Lista separada por vírgula, como na query string: o schema é quem a divide, e
        // montar o array à mão aqui pularia a normalização que ele faz.
        serviceIds: input.serviceIds.join(','),
        from: input.from,
        to: input.to,
      })
      return resolveAvailability(caller.tenantId, query)
    },

    async create(caller, input) {
      const parsed = CreateAppointmentSchema.parse({
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
        items: input.serviceIds.map((serviceId) => ({ serviceId })),
        ...(input.notes ? { notes: input.notes } : {}),
        acknowledgedAlerts: input.acknowledgedAlerts,
        // O que faz a antecedência mínima valer (RN-07) e o que marca a origem no
        // relatório do petshop. Sem isto o agendamento do Portal seria indistinguível do
        // que a recepção digitou.
        source: 'PORTAL',
      })

      const actor = actorOf(caller)
      const booking = await createBooking(
        actor,
        {
          petId: parsed.petId,
          professionalId: parsed.professionalId,
          startsAt: new Date(parsed.startsAt),
          items: parsed.items,
          notes: parsed.notes,
          source: parsed.source,
          acknowledgedAlerts: parsed.acknowledgedAlerts,
          override: parsed.override,
        },
        SEM_OVERRIDE,
      )

      return getAppointment(actor, booking.id)
    },

    async cancel(caller, appointmentId) {
      /**
       * Sem `waiveFee`: isentar a taxa é decisão da equipe. O schema é quem põe o padrão,
       * e o padrão é cobrar quando o cancelamento é tardio.
       */
      const input = CancelAppointmentSchema.parse({ reason: 'Cancelado pelo tutor no Portal' })
      const actor = actorOf(caller)
      await cancel(actor, appointmentId, input)
      return getAppointment(actor, appointmentId)
    },

    async reschedule(caller, appointmentId, input) {
      const parsed = RescheduleSchema.parse({
        startsAt: input.startsAt,
        professionalId: input.professionalId,
      })

      const actor = actorOf(caller)
      const result = await reschedule(
        actor,
        appointmentId,
        {
          startsAt: new Date(parsed.startsAt),
          professionalId: parsed.professionalId,
          reason: parsed.reason,
        },
        SEM_OVERRIDE,
      )

      return getAppointment(actor, result.newAppointmentId)
    },
  }
}

let port: SchedulingPort | null = null

export function getSchedulingPort(): SchedulingPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setSchedulingPort(next: SchedulingPort | null): void {
  port = next
}
