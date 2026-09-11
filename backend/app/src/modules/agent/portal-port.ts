import type {
  PortalAppointmentsResponse,
  PortalAvailabilityResponse,
  PortalBookingServicesResponse,
  PortalFinanceResponse,
  PortalPetSummary,
  PortalTaxiOffer,
  PortalTenantResponse,
} from '@petshop/shared-types'
import { listOwnAppointments } from '../portal/appointments.js'
import { listBookableServices, readAvailability } from '../portal/booking.js'
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
 * Sete métodos, todos de leitura, todos recortados ao `tutorId` **da conversa**. Nenhum
 * deles aceita um id de tutor vindo dos argumentos do modelo — é a RN-02, e é a diferença
 * entre uma tool e uma porta aberta.
 *
 * **A elevação de permissão é real e é curta.** O papel `TUTOR` não tem `finance:read`
 * nem `schedule:read_all`; estas leituras acontecem como se tivesse. O que as contém: o
 * `tutorId` vem de `resolveConversation` e nunca do corpo, a lista de métodos é curta e
 * nomeada, e nenhuma delas escreve.
 *
 * **O chamador não tem conta no Clerk.** Onde o Portal passa o `clerkUserId` do tutor,
 * aqui vai um sentinela — as funções de leitura não o consultam, e a auditoria de
 * escrita (que este módulo não faz) registraria `null`, como as automações do MOD-CRM.
 */

/** O tutor não está logado: quem fala é o número de telefone dele. */
const AGENT_CALLER = 'agent:whatsapp'

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
      return readAvailability({ tenantId, clerkUserId: AGENT_CALLER }, tutorId, {
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
      return readTaxiOffer({ tenantId, clerkUserId: AGENT_CALLER }, tutorId)
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
