import type { TenantTransaction } from '@petshop/db'

/**
 * Agenda, atrás de uma porta (AC-02 de MOD-PET-05).
 *
 * O AC exige recusar a transferência de um pet com agendamento futuro, listando quais
 * são. A regra foi escrita antes de existir quem respondesse, e a porta é o que
 * permitiu isso — mas o padrão vazio abaixo **valeu em produção da entrega do MOD-PET
 * até a fatia 9 da consolidação**, e nesse período o AC estava inerte: a lista sempre
 * vinha vazia, então nada bloqueava.
 *
 * Quem responde agora é `modules/scheduling/pet-port.ts`, ligado em
 * `registerSchedulingModule`. O padrão vazio fica para os testes que dublam a porta e
 * como o comportamento correto de um processo sem o módulo da agenda — não é mais o
 * estado normal do sistema.
 *
 * Mesmo padrão da porta do Clerk no MOD-IDENT e da do ViaCEP no MOD-TUTOR.
 */

export interface FutureAppointment {
  id: string
  startsAt: string
  serviceLabel: string
  tutorId: string | null
}

export interface SchedulingPort {
  listFuturePetAppointments(
    tx: TenantTransaction,
    tenantId: string,
    petId: string,
  ): Promise<FutureAppointment[]>
}

/** Sem o módulo da agenda ligado, nenhum pet tem agendamento futuro. */
const emptyPort: SchedulingPort = {
  async listFuturePetAppointments() {
    return []
  },
}

let port: SchedulingPort = emptyPort

export function setSchedulingPort(next: SchedulingPort | null): void {
  port = next ?? emptyPort
}

export function getScheduling(): SchedulingPort {
  return port
}
