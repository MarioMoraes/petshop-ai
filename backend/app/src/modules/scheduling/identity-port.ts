import type { SchedulingPort } from '../identity/scheduling-port.js'
import { OCCUPYING_STATUSES } from './conflicts.js'

/**
 * A resposta para a RN-07 do MOD-IDENT — tirar alguém da equipe com agenda marcada.
 *
 * O desligamento do **profissional** já tinha a regra (AC-04 de MOD-AGENDA-02, via
 * `AppointmentsPort`); o que não tinha era o caminho da **equipe**. Remover o vínculo
 * deixava o profissional ativo e os agendamentos apontando para quem não entra mais no
 * sistema — sábado chegava sem ninguém para atender, e nada tinha avisado.
 *
 * "Futuro" é relativo a **agora**, como nas outras portas da agenda: o que bloqueia é o
 * compromisso que ainda vai acontecer, nunca um banho de ontem.
 */
export const identitySchedulingPort: SchedulingPort = {
  async listFutureProfessionalAppointments(tx, tenantId, userId) {
    /**
     * Do usuário para o profissional, aqui dentro.
     *
     * `findMany` e não `findFirst`: `professionals.user_id` não é único — o espelho da
     * RN-06 é criado por atribuição de papel, e um histórico de promoções pode ter
     * deixado mais de uma linha para a mesma pessoa. Somar as agendas das duas é o
     * comportamento certo, porque o agendamento aponta para uma delas.
     */
    const profissionais = await tx.professional.findMany({
      where: { tenantId, userId },
      select: { id: true },
    })
    if (profissionais.length === 0) return []

    const rows = await tx.appointment.findMany({
      where: {
        professionalId: { in: profissionais.map((profissional) => profissional.id) },
        startsAt: { gt: new Date() },
        status: { in: [...OCCUPYING_STATUSES] },
      },
      select: {
        id: true,
        startsAt: true,
        pet: { select: { name: true } },
        items: { select: { label: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { startsAt: 'asc' },
      // O corpo do 409 é lido por uma pessoa decidindo na tela da equipe. Vinte linhas
      // já são mais do que se confere antes de decidir; o que importa é a contagem.
      take: 20,
    })

    return rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      petName: row.pet.name,
      serviceLabel: labelOf(row.items),
    }))
  },
}

/** "Banho e tosa" com um item, "Banho e mais 2" com vários — como em `pet-port.ts`. */
function labelOf(items: { label: string }[]): string {
  const first = items[0]?.label ?? 'Atendimento'
  const rest = items.length - 1
  return rest > 0 ? `${first} e mais ${rest}` : first
}
