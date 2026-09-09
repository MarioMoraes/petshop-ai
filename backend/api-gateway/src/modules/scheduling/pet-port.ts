import type { SchedulingPort } from '../pets/scheduling-port.js'
import { OCCUPYING_STATUSES } from './conflicts.js'

/**
 * A resposta de verdade para o AC-02 de MOD-PET-05 — a regra que estava inerte.
 *
 * O módulo do pet recusa transferir um animal com agendamento futuro **desde o MOD-PET**,
 * e a regra estava escrita, testada e no caminho da transferência. O que faltava era
 * quem respondesse: a porta devolvia lista vazia, então o bloqueio nunca acontecia em
 * produção. Um pet com banho marcado para sábado mudava de dono na quinta e o
 * agendamento seguia apontando para o tutor antigo.
 *
 * Ele não sumia de todo — o consumidor de `pet.transferido` reaponta os agendamentos
 * futuros para o novo tutor —, mas o AC pede que a pessoa **decida** antes, e não que o
 * sistema decida por ela.
 *
 * "Futuro" é relativo a **agora**, e não à data do agendamento: o que bloqueia é o
 * compromisso que ainda vai acontecer. Um banho de ontem, mesmo confirmado, não impede
 * transferência nenhuma.
 */
export const petSchedulingPort: SchedulingPort = {
  async listFuturePetAppointments(tx, _tenantId, petId) {
    const rows = await tx.appointment.findMany({
      where: {
        petId,
        startsAt: { gt: new Date() },
        status: { in: [...OCCUPYING_STATUSES] },
      },
      select: {
        id: true,
        startsAt: true,
        tutorId: true,
        items: { select: { label: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { startsAt: 'asc' },
      // O corpo do 409 é lido por uma pessoa na tela da transferência. Vinte linhas já
      // são mais do que alguém confere antes de decidir; o que importa é a contagem, e
      // ela vem do `length` da lista.
      take: 20,
    })

    return rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      serviceLabel: labelOf(row.items),
      tutorId: row.tutorId,
    }))
  },
}

/**
 * "Banho e tosa" com um item, "Banho e mais 2" com vários — o mesmo formato que o
 * extrato do financeiro usa para descrever um atendimento, e pela mesma razão: quem lê
 * quer reconhecer o compromisso, não auditar a composição dele.
 */
function labelOf(items: { label: string }[]): string {
  const first = items[0]?.label ?? 'Atendimento'
  const rest = items.length - 1
  return rest > 0 ? `${first} e mais ${rest}` : first
}
