import {
  CreateProfessionalSchema,
  UpdateProfessionalSchema,
  type AppointmentResponse,
  type CreateProfessionalInput,
  type ProfessionalResponse,
  type ServiceResponse,
  type UpdateProfessionalInput,
} from '@petshop/shared-types'
import type { ActorContext } from '../schedule-catalog/actor.js'
import { createBooking } from '../scheduling/booking.js'
import {
  createProfessional,
  listProfessionals,
  updateProfessional,
} from '../schedule-catalog/professionals.js'
import { listServices } from '../schedule-catalog/service.js'
import { listAppointments } from '../scheduling/queries.js'
import { tenantTimezone } from '../scheduling/timezone.js'
import { cancel } from '../scheduling/transitions.js'

/**
 * A porta para o MOD-AGENDA — a mais carregada das três, e a única que **escreve por
 * regra e não por cadastro**.
 *
 * O agendamento importado passa por `createBooking`, inteiro: duração calculada da
 * tabela do porte corrigida pela pelagem, preço congelado no momento da criação,
 * jornada do profissional, habilitação por serviço, capacidade simultânea e a transação
 * `SERIALIZABLE` da corrida do último lugar. Reimplementar isso aqui produziria uma
 * segunda agenda, que divergiria da primeira no dia em que uma das duas mudasse.
 *
 * Duas consequências que o operador sente, e que são o comportamento certo:
 *
 * - **o profissional precisa ter jornada e habilitação antes** — a linha falha dizendo
 *   "Fulana não atende neste horário" ou "Fulana não executa Banho", que é o mesmo que
 *   o balcão ouviria;
 * - **o horário ocupado recusa** — dois agendamentos para o mesmo profissional no mesmo
 *   horário, acima da capacidade dele, não entram os dois. A planilha do sistema antigo
 *   pode ter aceitado; esta agenda não aceita, e é por isso que ela vale.
 *
 * `source` é `STAFF`: é o que desliga a antecedência mínima (que só vale para o Portal)
 * e o que a origem no relatório do petshop vai dizer. Não existe `IMPORT` no enum de
 * origem, e acrescentá-lo custaria uma migração de tipo para distinguir uma carga que
 * acontece uma vez na vida do estabelecimento.
 */

export interface SchedulingPort {
  timezone(tenantId: string): Promise<string>
  listProfessionals(actor: ActorContext): Promise<ProfessionalResponse[]>
  createProfessional(
    actor: ActorContext,
    input: CreateProfessionalInput,
  ): Promise<ProfessionalResponse>
  updateProfessional(
    actor: ActorContext,
    professionalId: string,
    patch: UpdateProfessionalInput,
  ): Promise<void>
  listServices(actor: ActorContext): Promise<ServiceResponse[]>
  /** Os agendamentos de um pet numa janela — é por eles que a chave natural resolve. */
  listForPet(
    actor: ActorContext,
    petId: string,
    from: Date,
    to: Date,
  ): Promise<AppointmentResponse[]>
  /** Tem agenda? É o que impede o desfazer de apagar um pet que já foi marcado. */
  hasAppointments(actor: ActorContext, petId: string): Promise<boolean>
  book(actor: ActorContext, input: BookingRequest): Promise<{ id: string }>
  /** Desfazer: cancela o que a carga criou, sem taxa e sem avisar ninguém. */
  cancelSilently(actor: ActorContext, appointmentId: string): Promise<void>
}

export interface BookingRequest {
  petId: string
  professionalId: string
  startsAt: Date
  serviceIds: string[]
  notes?: string | undefined
}

/**
 * A carga nunca libera crédito.
 *
 * O gate de inadimplência continua valendo: um cliente que deve acima do limite não
 * ganha horário porque a planilha dizia que tinha. Quem libera é um administrador, na
 * tela, com justificativa — e o relatório da linha diz exatamente isso.
 */
const SEM_OVERRIDE = { canOverrideCredit: false } as const

function createInProcessPort(): SchedulingPort {
  return {
    timezone(tenantId) {
      return tenantTimezone(tenantId)
    },

    listProfessionals(actor) {
      // Inclui os inativos: a chave natural é o nome, e reimportar sobre alguém que foi
      // desligado precisa achá-lo para atualizar em vez de criar um homônimo.
      return listProfessionals(actor, true)
    },

    createProfessional(actor, input) {
      return createProfessional(actor, CreateProfessionalSchema.parse(input))
    },

    async updateProfessional(actor, professionalId, patch) {
      await updateProfessional(actor, professionalId, UpdateProfessionalSchema.parse(patch))
    },

    listServices(actor) {
      return listServices(actor, true)
    },

    listForPet(actor, petId, from, to) {
      return listAppointments(actor, {
        petId,
        from: from.toISOString(),
        to: to.toISOString(),
      })
    },

    async hasAppointments(actor, petId) {
      const rows = await listAppointments(actor, { petId })
      return rows.length > 0
    },

    async book(actor, input) {
      const booking = await createBooking(
        actor,
        {
          petId: input.petId,
          professionalId: input.professionalId,
          startsAt: input.startsAt,
          items: input.serviceIds.map((serviceId) => ({ serviceId })),
          ...(input.notes ? { notes: input.notes } : {}),
          source: 'STAFF',
          // O que impede trezentas confirmações de horários que o cliente marcou
          // semana passada, por um sistema que ele ainda não conhece.
          notify: false,
        },
        SEM_OVERRIDE,
      )
      return { id: booking.id }
    },

    async cancelSilently(actor, appointmentId) {
      await cancel(actor, appointmentId, {
        reason: 'Importação desfeita',
        // `systemInitiated` **e** `waiveFee`: desfazer uma carga não é o tutor
        // desmarcando, e cobrar taxa de cancelamento tardio por um erro de operação do
        // petshop seria a pior forma possível de estrear o sistema.
        systemInitiated: true,
        waiveFee: true,
        notify: false,
      })
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
