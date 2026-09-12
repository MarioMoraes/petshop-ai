import type { TenantTransaction } from '@petshop/db'

/**
 * A agenda, atrás de uma porta (RN-07 de MOD-IDENT).
 *
 * "Remoção de membership com agenda futura bloqueia com 409 listando os agendamentos
 * pendentes; exige reatribuição ou cancelamento prévio." A regra é de identidade, o dado
 * é da agenda, e o MOD-IDENT não importa `appointments` — ele pergunta.
 *
 * A pergunta é feita por **usuário**, e não por profissional: quem sai da equipe é a
 * pessoa, e é do outro lado da porta que se sabe que ela tem espelho em `professionals`
 * (RN-06). Devolver `professionalId` daqui obrigaria a identidade a conhecer a tabela
 * para depois perguntar sobre ela.
 *
 * Mesmo desenho da porta do Clerk neste módulo e da `SchedulingPort` do MOD-PET.
 */

export interface FutureProfessionalAppointment {
  id: string
  startsAt: string
  petName: string
  serviceLabel: string
}

export interface SchedulingPort {
  listFutureProfessionalAppointments(
    tx: TenantTransaction,
    tenantId: string,
    userId: string,
  ): Promise<FutureProfessionalAppointment[]>
}

/**
 * Sem o módulo da agenda ligado, ninguém tem agendamento futuro.
 *
 * **O padrão vazio é o comportamento correto de um processo sem a agenda, e não o estado
 * normal do sistema** — a distinção que o AC-02 de MOD-PET-05 ensinou do jeito difícil:
 * uma regra cuja porta nunca é ligada em produção está escrita, testada e inerte.
 */
const emptyPort: SchedulingPort = {
  async listFutureProfessionalAppointments() {
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
