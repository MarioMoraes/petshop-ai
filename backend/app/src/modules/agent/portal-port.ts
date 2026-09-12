import type {
  PortalAppointmentDetail,
  PortalAppointmentsResponse,
  PortalAvailabilityResponse,
  PortalBookingServicesResponse,
  PortalFinanceResponse,
  PortalPetSummary,
  PortalTaxiOffer,
  PortalTenantResponse,
} from '@petshop/shared-types'
import {
  cancelOwnAppointment,
  listOwnAppointments,
  readOwnAppointment,
  rescheduleOwnAppointment,
} from '../portal/appointments.js'
import {
  createBooking,
  listBookableServices,
  readAvailability,
  type CreatedBooking,
} from '../portal/booking.js'
import { readOwnFinance } from '../portal/finance.js'
import { readPortalTenant } from '../portal/me.js'
import { listOwnPets } from '../portal/pets.js'
import { readTaxiOffer } from '../portal/taxi.js'

/**
 * A **sexta porta** do MOD-PORTAL (§5 do PRD agentes_ia_15).
 *
 * As cinco primeiras são as do Portal; esta é a do agente, e tem o mesmo desenho pela
 * mesma razão: **o agente e a tela do tutor precisam responder a mesma coisa**. Duas
 * implementações da pergunta "que horas é o banho do Thor?" divergem no dia em que uma
 * das duas mudar, e o cliente passa a receber respostas diferentes conforme onde
 * pergunta.
 *
 * Onze métodos, todos recortados ao `tutorId` **da conversa**. Nenhum deles aceita um id
 * de tutor vindo dos argumentos do modelo — é a RN-02, e é a diferença entre uma tool e
 * uma porta aberta.
 *
 * **Sete leem e quatro escrevem** (fatia 3). A divisão não é de conveniência: as quatro
 * últimas só são alcançadas por `confirmarProposta`, depois de o tutor ter dito sim a uma
 * proposta gravada — é a RN-03, e é o que impede o modelo de agendar porque entendeu
 * errado uma frase.
 *
 * **A elevação de permissão é real e é curta.** O papel `TUTOR` não tem `finance:read`,
 * `schedule:read_all` nem `schedule:write_all`; tudo isto acontece como se tivesse. O que
 * contém: o `tutorId` vem de `resolveConversation` e nunca do corpo, a lista de métodos é
 * curta e nomeada, e as escritas passam pelas **mesmas** funções do Portal — com os
 * mesmos gates, o mesmo `canOverrideCredit: false` e a mesma taxa de cancelamento.
 *
 * **O chamador não tem conta no Clerk.** Onde o Portal passa o `clerkUserId` do tutor,
 * aqui vai um sentinela — as funções de leitura não o consultam, e a auditoria do domínio
 * registra `null`, como as automações do MOD-CRM. Quem diz que foi o agente é a linha que
 * `proposals.ts` grava, com a conversa e o turno.
 */

/** O tutor não está logado: quem fala é o número de telefone dele. */
const AGENT_CALLER = 'agent:whatsapp'

/** O chamador que as funções do Portal esperam, montado sem sessão. */
function callerOf(tenantId: string) {
  return { tenantId, clerkUserId: AGENT_CALLER }
}

export interface AgentBookingRequest {
  petId: string
  serviceIds: string[]
  professionalId: string
  startsAt: string
}

export interface AgentRescheduleRequest {
  professionalId: string
  startsAt: string
}

export interface AgentPortalPort {
  pets(tenantId: string, tutorId: string): Promise<PortalPetSummary[]>
  appointments(tenantId: string, tutorId: string): Promise<PortalAppointmentsResponse>
  availability(
    tenantId: string,
    tutorId: string,
    input: { petId: string; serviceIds: string[]; date: string },
  ): Promise<PortalAvailabilityResponse>
  services(tenantId: string, tutorId: string, petId: string): Promise<PortalBookingServicesResponse>
  finance(tenantId: string, tutorId: string): Promise<PortalFinanceResponse>
  tenant(tenantId: string): Promise<PortalTenantResponse>
  taxi(tenantId: string, tutorId: string): Promise<PortalTaxiOffer>

  // ─── As escritas (MOD-AI-04) ───────────────────────────────────────────────

  appointment(
    tenantId: string,
    tutorId: string,
    appointmentId: string,
  ): Promise<PortalAppointmentDetail>
  book(tenantId: string, tutorId: string, input: AgentBookingRequest): Promise<CreatedBooking>
  cancelAppointment(
    tenantId: string,
    tutorId: string,
    appointmentId: string,
  ): Promise<PortalAppointmentDetail>
  rescheduleAppointment(
    tenantId: string,
    tutorId: string,
    appointmentId: string,
    input: AgentRescheduleRequest,
  ): Promise<PortalAppointmentDetail>
}

function createInProcessPort(): AgentPortalPort {
  return {
    pets(tenantId, tutorId) {
      return listOwnPets(tenantId, tutorId)
    },

    appointments(tenantId, tutorId) {
      // Cinco: o agente responde "quando é o próximo", não faz extrato de agenda — e
      // cada linha a mais é prompt pago em todo turno seguinte da conversa.
      return listOwnAppointments(tenantId, tutorId, { limit: 5 })
    },

    availability(tenantId, tutorId, input) {
      /**
       * **`readAvailability` do Portal, e não `resolveAvailability` do MOD-AGENDA.**
       *
       * A do Portal faz três coisas a mais que o agente precisaria refazer: confere que
       * o agendamento online está ligado, confere a posse do pet, e filtra a grade pela
       * antecedência mínima do tenant. Oferecer 10:30 e depois recusá-la é a definição
       * de armadilha — e um agente que a criasse seria pior que nenhum.
       */
      return readAvailability(callerOf(tenantId), tutorId, {
        petId: input.petId,
        serviceIds: input.serviceIds,
        date: input.date,
      })
    },

    services(tenantId, tutorId, petId) {
      return listBookableServices(tenantId, tutorId, petId)
    },

    finance(tenantId, tutorId) {
      return readOwnFinance(tenantId, tutorId)
    },

    tenant(tenantId) {
      return readPortalTenant(tenantId)
    },

    taxi(tenantId, tutorId) {
      return readTaxiOffer(callerOf(tenantId), tutorId)
    },

    appointment(tenantId, tutorId, appointmentId) {
      return readOwnAppointment(tenantId, tutorId, appointmentId)
    },

    book(tenantId, tutorId, input) {
      /**
       * **`acknowledgedAlerts` é sempre falso, e é uma decisão e não um esquecimento.**
       *
       * O campo existe para o tutor confirmar que leu o alerta clínico crítico do pet
       * (RN-09 do MOD-PORTAL). O agente não fala de saúde — o prompt o proíbe, e a lista
       * de tools não tem por onde ele ler um alerta. Marcá-lo aqui seria o robô dando,
       * em nome do cliente, um aceite que o cliente não viu.
       *
       * Quando o pet tem alerta, o domínio recusa e a conversa vai para a recepção com
       * motivo `WRITE_FAILED` — que é o desfecho certo: quem explica um alerta clínico é
       * gente.
       *
       * **Sem `taxi`**, pela mesma razão da lista curta: o leva-e-traz tem gate de vaga,
       * endereço e janela, e nada disso cabe numa confirmação de uma palavra.
       */
      return createBooking(callerOf(tenantId), tutorId, {
        petId: input.petId,
        serviceIds: input.serviceIds,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
        acknowledgedAlerts: false,
      })
    },

    cancelAppointment(tenantId, tutorId, appointmentId) {
      /**
       * `acknowledgeFee: true`, e o que o autoriza está uma etapa antes.
       *
       * A taxa de cancelamento tardio é lida na **proposta** e dita ao cliente em reais
       * antes de ele confirmar — é exatamente o desenho que o AC-03 de MOD-PORTAL-06 pede
       * da tela, com a vantagem de a frase ser lida em vez de aparecer num diálogo. O que
       * chega aqui já passou por esse "sim".
       */
      return cancelOwnAppointment(callerOf(tenantId), tutorId, appointmentId, {
        acknowledgeFee: true,
      })
    },

    rescheduleAppointment(tenantId, tutorId, appointmentId, input) {
      return rescheduleOwnAppointment(callerOf(tenantId), tutorId, appointmentId, {
        startsAt: input.startsAt,
        professionalId: input.professionalId,
      })
    },
  }
}

let port: AgentPortalPort | null = null

export function getAgentPortalPort(): AgentPortalPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setAgentPortalPort(next: AgentPortalPort | null): void {
  port = next
}
