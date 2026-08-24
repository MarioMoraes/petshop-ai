import type { TenantTransaction } from '@petshop/db'
import type { AppointmentsPort, FutureAppointment } from '../catalog/port.js'
import { OCCUPYING_STATUSES } from './conflicts.js'

/**
 * A implementação real da porta que a fatia 1 deixou esperando.
 *
 * Nada em `modules/catalog` mudou para isto funcionar: as três regras — serviço em
 * uso (AC-03), desligamento com agenda cheia (AC-04) e bloqueio sobre agendamento
 * (AC-02) — já estavam escritas e testadas contra uma porta que respondia "nenhum".
 * Trocar o "nenhum" pela consulta de verdade é o único passo.
 *
 * "Futuro" é sempre relativo a **agora**, e não à data do agendamento: o que impede
 * excluir um serviço é o compromisso que ainda vai acontecer. Um agendamento de
 * ontem, mesmo confirmado, não bloqueia nada.
 */

function futureFilter() {
  return {
    startsAt: { gt: new Date() },
    status: { in: [...OCCUPYING_STATUSES] },
  }
}

async function toFutureAppointments(
  tx: TenantTransaction,
  where: object,
): Promise<FutureAppointment[]> {
  const rows = await tx.appointment.findMany({
    where,
    include: { pet: { select: { name: true } } },
    orderBy: { startsAt: 'asc' },
    take: 100,
  })
  return rows.map((row) => ({
    id: row.id,
    startsAt: row.startsAt,
    petName: row.pet.name,
  }))
}

export const livePort: AppointmentsPort = {
  async countByService(tx, serviceId) {
    return tx.appointment.count({
      where: { ...futureFilter(), items: { some: { serviceId } } },
    })
  },

  async listByProfessional(tx, professionalId) {
    return toFutureAppointments(tx, { ...futureFilter(), professionalId })
  },

  async listInWindow(tx, professionalId, startsAt, endsAt) {
    return toFutureAppointments(tx, {
      status: { in: [...OCCUPYING_STATUSES] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      // Feriado do tenant (`professionalId` nulo) pega a agenda de todo mundo.
      ...(professionalId ? { professionalId } : {}),
    })
  },

  async cancelBatch(tx, appointmentIds, reason) {
    if (appointmentIds.length === 0) return

    // RN-12: cancelamento em lote por bloqueio **não** gera taxa de no-show. A falta
    // é do petshop, e por isso `cancelled_late` fica falso mesmo em cima da hora.
    await tx.appointment.updateMany({
      where: { id: { in: appointmentIds } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledLate: false },
    })

    // A trilha de estado recebe uma linha por agendamento: "por que isto foi
    // cancelado" é a pergunta que o tutor faz, e "bloqueio na agenda" é a resposta.
    for (const appointmentId of appointmentIds) {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId },
        select: { tenantId: true },
      })
      if (!appointment) continue

      await tx.appointmentStatusLog.create({
        data: {
          tenantId: appointment.tenantId,
          appointmentId,
          fromStatus: 'CONFIRMED',
          toStatus: 'CANCELLED',
          reason: reason.slice(0, 200),
        },
      })
    }
  },
}
