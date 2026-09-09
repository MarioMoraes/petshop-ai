import type { TenantTransaction } from '@petshop/db'

/**
 * Agenda, atrás de uma porta (AC-02 de MOD-PET-05).
 *
 * O AC exige recusar a transferência de um pet com agendamento futuro, listando quais
 * são. MOD-AGENDA ainda não existe — mas a regra existe, e escondê-la até lá faria
 * com que, no dia em que a agenda chegasse, alguém tivesse de lembrar de voltar aqui.
 *
 * A porta inverte isso: a regra está escrita, testada e no caminho da transferência
 * desde já; o que falta é a implementação, que hoje responde "nenhum agendamento".
 * Quando MOD-AGENDA chegar, é `setSchedulingPort` no `app.ts` e nada mais muda.
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

/** Enquanto MOD-AGENDA não existe, nenhum pet tem agendamento futuro. */
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
