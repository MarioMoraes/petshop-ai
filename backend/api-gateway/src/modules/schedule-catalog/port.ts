import type { TenantTransaction } from '@petshop/db'

/**
 * Porta para a fatia 2 do MOD-AGENDA.
 *
 * Três regras desta fatia dependem de `appointments`, tabela que ainda não existe:
 * o AC-03 do serviço em uso, o AC-04 do desligamento e o AC-02 do bloqueio sobre
 * agendamento. Em vez de adiá-las — e reabrir estes arquivos depois —, elas estão
 * escritas, testadas e no caminho, atrás desta porta.
 *
 * É o mesmo padrão que o MOD-PET usa para o AC-02 da transferência
 * (`modules/pets/scheduling-port.ts`). A fatia 2 do módulo chegou e a ligação é
 * `setAppointmentsPort` em `registerSchedulingModule`; nada mudou nos módulos que a
 * consomem.
 */

export interface FutureAppointment {
  id: string
  startsAt: Date
  petName: string
}

export interface AppointmentsPort {
  /** Agendamentos futuros de um serviço, para o AC-03 de MOD-AGENDA-01. */
  countByService: (tx: TenantTransaction, serviceId: string) => Promise<number>
  /** Agendamentos futuros de um profissional, para o AC-04 de MOD-AGENDA-02. */
  listByProfessional: (
    tx: TenantTransaction,
    professionalId: string,
  ) => Promise<FutureAppointment[]>
  /**
   * Agendamentos dentro de uma janela, para o AC-02 de MOD-AGENDA-03.
   * `professionalId` nulo é o feriado: pega a agenda de todo mundo.
   */
  listInWindow: (
    tx: TenantTransaction,
    professionalId: string | null,
    startsAt: Date,
    endsAt: Date,
  ) => Promise<FutureAppointment[]>
  /** Cancelamento em lote por bloqueio — **sem** taxa de no-show (RN-12). */
  cancelBatch: (tx: TenantTransaction, appointmentIds: string[], reason: string) => Promise<void>
}

/**
 * O padrão de quando `appointments` ainda não existia: "nenhum". Continua aqui porque é
 * o que a suíte reseta entre os testes, e porque um módulo do catálogo carregado sem a
 * outra metade deve responder isso em vez de lançar.
 */
const emptyPort: AppointmentsPort = {
  countByService: async () => 0,
  listByProfessional: async () => [],
  listInWindow: async () => [],
  cancelBatch: async () => undefined,
}

let port: AppointmentsPort = emptyPort

export function appointments(): AppointmentsPort {
  return port
}

export function setAppointmentsPort(next: AppointmentsPort): void {
  port = next
}

export function resetAppointmentsPort(): void {
  port = emptyPort
}
