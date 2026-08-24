import type { TenantTransaction } from '@petshop/db'

/**
 * Porta para a fatia 2 do MOD-AGENDA.
 *
 * Três regras desta fatia dependem de `appointments`, tabela que ainda não existe:
 * o AC-03 do serviço em uso, o AC-04 do desligamento e o AC-02 do bloqueio sobre
 * agendamento. Em vez de adiá-las — e reabrir estes arquivos depois —, elas estão
 * escritas, testadas e no caminho, atrás desta porta.
 *
 * É o mesmo padrão que o pet-service usou para o AC-02 da transferência
 * (`lib/scheduling.ts`). Quando a fatia 2 chegar é `setAppointmentsPort` no `app.ts`
 * e nada mais muda nos módulos que a consomem.
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
 * Enquanto `appointments` não existe, a resposta honesta é "nenhum". Não é um dublê
 * de teste: é o estado real do sistema hoje, e é por isso que a porta tem um padrão
 * em vez de lançar.
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
