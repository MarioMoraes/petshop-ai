import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { logger } from '../../lib/logger.js'
import { loadAppointmentVariables } from './appointment-vars.js'
import { resolveAutomation } from './automations.js'
import { getMessagingPort } from './messaging-port.js'

/**
 * O lembrete de agendamento (MOD-CRM-05).
 *
 * É uma **varredura sobre o banco**, não um consumidor de evento, e essa é a decisão
 * mais importante deste arquivo. O publish de eventos ainda é best-effort pós-commit
 * (`TODO(MOD-ADMIN)` no service-kit): um evento perdido seria um lembrete que nunca
 * sai, e ninguém descobriria — exceto o cliente que faltou. A varredura reencontra o
 * agendamento na hora seguinte, e o `dedupeKey` impede a duplicata.
 *
 * A janela é de uma hora, casada com a frequência do job. Um agendamento cuja marca de
 * `leadHours` cai entre duas passadas seria perdido por uma varredura de ponto; por
 * isso a busca é por **intervalo**, não por instante.
 */

export interface ReminderSummary {
  scanned: number
  enqueued: number
  skipped: number
}

const REMINDABLE = ['PENDING', 'CONFIRMED'] as const

export async function sendAppointmentReminders(
  now: Date = new Date(),
): Promise<ReminderSummary> {
  const summary: ReminderSummary = { scanned: 0, enqueued: 0, skipped: 0 }

  const tenants = await getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM appointments
     WHERE status IN ('PENDING', 'CONFIRMED')
       AND starts_at > ${now}
  `

  for (const { tenant_id: tenantId } of tenants) {
    try {
      summary.scanned += await remindTenant(tenantId, now, summary)
    } catch (error) {
      // Um tenant com problema não pode travar os lembretes dos outros.
      logger.error({ err: error, tenantId }, 'falha ao varrer lembretes do tenant')
    }
  }

  if (summary.enqueued > 0) logger.info(summary, 'lembretes de agendamento enfileirados')
  return summary
}

async function remindTenant(
  tenantId: string,
  now: Date,
  summary: ReminderSummary,
): Promise<number> {
  const automation = await withTenant(tenantId, (tx) =>
    resolveAutomation(tx, 'appointment_reminder'),
  )
  if (!automation.enabled) return 0

  const leadHours = Number(automation.config.leadHours ?? 24)
  const from = new Date(now.getTime() + leadHours * 3_600_000)
  const to = new Date(from.getTime() + 3_600_000)

  const appointments = await withTenant(tenantId, (tx) =>
    tx.appointment.findMany({
      where: { status: { in: [...REMINDABLE] }, startsAt: { gte: from, lt: to } },
      select: { id: true },
      take: 500,
    }),
  )

  const port = getMessagingPort()
  for (const { id } of appointments) {
    const context = await withTenant(tenantId, (tx) => loadAppointmentVariables(tx, id))
    if (!context) {
      summary.skipped += 1
      continue
    }

    const ok = await port.enqueue({
      tenantId,
      tutorId: context.tutorId,
      petId: context.petId,
      templateKey: automation.templateKey,
      channel: automation.channel,
      // A chave é o agendamento, não a hora da varredura: duas passadas sobre o mesmo
      // agendamento produzem a mesma chave, e a segunda não cria nada.
      dedupeKey: `reminder:${id}`,
      originType: 'APPOINTMENT',
      originId: id,
      variables: context.variables,
    })

    if (ok) summary.enqueued += 1
    else summary.skipped += 1
  }

  return appointments.length
}
