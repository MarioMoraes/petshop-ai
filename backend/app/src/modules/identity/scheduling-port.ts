import type { TenantTransaction } from '@petshop/db'
import type { ProfessionalRoleKey } from '@petshop/shared-types'

/**
 * A agenda, atrás de uma porta (RN-06 e RN-07 de MOD-IDENT).
 *
 * Duas regras de identidade cujo dado mora na agenda, e o MOD-IDENT não importa
 * `professionals` — ele pergunta:
 *
 * - **RN-07**: "Remoção de membership com agenda futura bloqueia com 409 listando os
 *   agendamentos pendentes; exige reatribuição ou cancelamento prévio."
 * - **RN-06**: "Ao atribuir papel GROOMER/BATHER/VET/DRIVER, o sistema cria/reativa o
 *   registro correspondente em `professionals`."
 *
 * A leitura é feita por **usuário**, e não por profissional: quem sai da equipe é a
 * pessoa, e é do outro lado da porta que se sabe que ela tem espelho em `professionals`.
 * Devolver `professionalId` daqui obrigaria a identidade a conhecer a tabela para depois
 * perguntar sobre ela.
 *
 * **O PRD diz "via evento", e aqui é chamada de função — de propósito.** O evento era o
 * transporte de quando MOD-IDENT e MOD-AGENDA eram dois processos; num processo só ele
 * custaria o que a consolidação já cobrou duas vezes: com `DISABLE_EVENTS` (o `pnpm dev`
 * e a suíte) o espelho simplesmente nunca nasceria, e com o broker de pé haveria uma
 * janela entre o papel atribuído e o profissional existindo — a tela da agenda aberta
 * nessa janela mostra uma equipe incompleta. `membership.papel_alterado` continua sendo
 * publicado; o que ele não é mais é o único caminho.
 *
 * Mesmo desenho da porta do Clerk neste módulo e da `SchedulingPort` do MOD-PET.
 */

export interface FutureProfessionalAppointment {
  id: string
  startsAt: string
  petName: string
  serviceLabel: string
}

/** O que a identidade sabe da pessoa e a agenda precisa para abrir a ficha dela. */
export interface ProfessionalMirrorInput {
  userId: string
  /** `users.full_name` — a agenda corta em 60, que é o limite da coluna dela. */
  displayName: string
  roleKey: ProfessionalRoleKey
  actorUserId: string | null
}

/**
 * O que o espelho fez, para a trilha e para o aviso pós-commit.
 *
 * `ADOPTED` é o cadastro que o administrador já tinha criado à mão na agenda e que
 * passou a ter dono — a distinção importa no log: ninguém cadastrou ninguém, um cadastro
 * ganhou vínculo.
 */
export interface ProfessionalMirror {
  professionalId: string
  action: 'CREATED' | 'ADOPTED' | 'REACTIVATED' | 'UPDATED' | 'DEACTIVATED'
}

export interface SchedulingPort {
  listFutureProfessionalAppointments(
    tx: TenantTransaction,
    tenantId: string,
    userId: string,
  ): Promise<FutureProfessionalAppointment[]>

  /**
   * RN-06 — o papel operacional ganha ficha na agenda.
   *
   * Roda **dentro da transação de quem atribui o papel**: o membership e o espelho
   * nascem juntos ou não nascem. Sem isso existiria o estado "é GROOMER, mas não está na
   * agenda", que é exatamente o defeito que esta fatia fecha.
   */
  mirrorProfessional(
    tx: TenantTransaction,
    tenantId: string,
    input: ProfessionalMirrorInput,
  ): Promise<ProfessionalMirror | null>

  /**
   * O papel operacional saiu — por rebaixamento ou por remoção do vínculo.
   *
   * **Não confere a agenda futura**: quem confere é o chamador, antes, com
   * `listFutureProfessionalAppointments`, porque é ele que sabe dizer 409 com a lista.
   * Chamar sem conferir desativa um profissional com banho marcado.
   */
  dropProfessionalMirror(
    tx: TenantTransaction,
    tenantId: string,
    input: { userId: string; actorUserId: string | null },
  ): Promise<ProfessionalMirror | null>

  /**
   * O que só pode acontecer **depois do commit**: derrubar o cache do catálogo e
   * publicar `agenda.profissional.alterado`.
   *
   * Separado do resto porque invalidar cache dentro da transação é convite a
   * repopulá-lo com o estado velho — entre o `DEL` e o commit cabe uma leitura. E o
   * evento é vocabulário da agenda: publicá-lo da identidade seria o import solto que a
   * porta existe para evitar.
   */
  announceProfessionalChange(tenantId: string, mirror: ProfessionalMirror): Promise<void>
}

/**
 * Sem o módulo da agenda ligado, ninguém tem agendamento futuro e ninguém tem espelho.
 *
 * **O padrão vazio é o comportamento correto de um processo sem a agenda, e não o estado
 * normal do sistema** — a distinção que o AC-02 de MOD-PET-05 ensinou do jeito difícil:
 * uma regra cuja porta nunca é ligada em produção está escrita, testada e inerte.
 */
const emptyPort: SchedulingPort = {
  async listFutureProfessionalAppointments() {
    return []
  },
  async mirrorProfessional() {
    return null
  },
  async dropProfessionalMirror() {
    return null
  },
  async announceProfessionalChange() {
    // Nada a avisar: não houve espelho.
  },
}

let port: SchedulingPort = emptyPort

export function setSchedulingPort(next: SchedulingPort | null): void {
  port = next ?? emptyPort
}

export function getScheduling(): SchedulingPort {
  return port
}
