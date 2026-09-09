import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { publishEvent } from '../../shared/events.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { createBooking } from './booking.js'
import { expandOccurrences, parseRRule, MATERIALIZATION_WEEKS } from './recurrence.js'
import { markNoShow } from './transitions.js'

/**
 * Os três jobs da agenda (§10 do PRD).
 *
 * Todos varrem **todos os tenants**, e por isso a consulta que descobre o que fazer
 * usa `app_maintenance` (com BYPASSRLS) enquanto o **trabalho em si** roda dentro de
 * `withTenant`. É a separação que `packages/db/src/platform.ts` estabeleceu: descobrir
 * é cross-tenant, agir nunca é.
 *
 * Nenhum deles é agendado aqui. Quem os chama no relógio é o MOD-CRON; estas funções
 * são o corpo do trabalho, e existirem separadas é o que as torna testáveis sem
 * esperar meia hora.
 */

/** AC-03 de MOD-AGENDA-08: tolerância de 60 min depois de `starts_at`. */
export const NO_SHOW_TOLERANCE_MIN = 60

/** AC-03 de MOD-AGENDA-06: a reserva da solicitação vale 24h. */
export const APPROVAL_EXPIRY_HOURS = 24

interface PendingRow {
  id: string
  tenant_id: string
}

/**
 * `no-show-sweeper` — o horário passou e ninguém apareceu.
 *
 * O índice parcial `idx_appointments_noshow` existe exatamente para esta consulta:
 * `status = 'CONFIRMED' AND checkin_at IS NULL`, ordenado por `starts_at`.
 *
 * A tolerância não é preciosismo. Sem ela, o job rodando às 09:31 marcaria falta de
 * quem tem horário às 09:30 e está estacionando o carro.
 */
export async function sweepNoShows(now: Date = new Date()): Promise<{ marked: number }> {
  const cutoff = new Date(now.getTime() - NO_SHOW_TOLERANCE_MIN * 60_000)

  const rows = await getMaintenancePrisma().$queryRaw<PendingRow[]>`
    SELECT id, tenant_id FROM appointments
     WHERE status = 'CONFIRMED' AND checkin_at IS NULL AND starts_at < ${cutoff}
     ORDER BY starts_at ASC
     LIMIT 500
  `

  let marked = 0
  for (const row of rows) {
    try {
      await markNoShow({ tenantId: row.tenant_id }, row.id)
      marked += 1
    } catch (error) {
      // Uma falta que não pôde ser marcada não pode derrubar as outras 499.
      logger.error({ err: error, appointmentId: row.id }, 'falha ao marcar no-show')
    }
  }

  if (marked > 0) {
    recordMetric({ metric: 'appointment_no_show_total', value: marked, unit: 'count' })
  }
  return { marked }
}

/**
 * `booking-approval-expiry` — a solicitação do Portal esperou 24h sem decisão.
 *
 * Expirar é obrigatório, não opcional: enquanto `PENDING`, o agendamento **ocupa
 * lugar** na agenda. Uma solicitação esquecida seria um horário bloqueado para sempre
 * por alguém que talvez nem se lembre de ter pedido.
 */
export async function expirePendingApprovals(
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const cutoff = new Date(now.getTime() - APPROVAL_EXPIRY_HOURS * 3_600_000)

  const rows = await getMaintenancePrisma().$queryRaw<PendingRow[]>`
    SELECT id, tenant_id FROM appointments
     WHERE status = 'PENDING' AND created_at < ${cutoff}
     ORDER BY created_at ASC
     LIMIT 500
  `

  let expired = 0
  for (const row of rows) {
    try {
      await withTenant(row.tenant_id, async (tx) => {
        await tx.appointment.update({
          where: { id: row.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledLate: false },
        })
        await tx.appointmentStatusLog.create({
          data: {
            tenantId: row.tenant_id,
            appointmentId: row.id,
            fromStatus: 'PENDING',
            toStatus: 'CANCELLED',
            reason: 'Solicitação expirada sem aprovação',
          },
        })
      })
      /**
       * O tutor precisa saber que o pedido dele morreu.
       *
       * O evento é o mesmo do cancelamento pelo balcão, e é o que faz o MOD-CRM mandar
       * o aviso — o consumidor de `agendamento.cancelado` já existe desde a fatia 1 do
       * CRM. Sem esta linha, quem pediu horário pelo site esperava a confirmação, não
       * recebia nada, e aparecia no petshop no dia marcado.
       *
       * `late: false` e `feeCents: 0` porque a falta não é dele: quem não decidiu foi o
       * estabelecimento, e cobrar taxa por isso seria o pior tipo de erro de produto.
       */
      await publishEvent('agendamento.cancelado', {
        tenantId: row.tenant_id,
        appointmentId: row.id,
        late: false,
        feeCents: 0,
        cancelledBy: null,
      })

      expired += 1
    } catch (error) {
      logger.error({ err: error, appointmentId: row.id }, 'falha ao expirar solicitação')
    }
  }

  return { expired }
}

interface RecurrenceRow {
  id: string
  tenant_id: string
  pet_id: string
  professional_id: string
  rrule: string
  starts_at: Date
  until: Date | null
  materialized_until: Date | null
  service_ids: string[]
}

/**
 * `recurrence-extender` — empurra o horizonte das séries ativas.
 *
 * RN-14 materializa 12 semanas; este job as mantém sempre 12 semanas à frente. Roda
 * semanalmente e só toca as séries cujo horizonte está por vencer.
 */
export async function extendRecurrences(now: Date = new Date()): Promise<{ created: number }> {
  const horizon = new Date(now.getTime() + MATERIALIZATION_WEEKS * 7 * 24 * 3_600_000)

  const rows = await getMaintenancePrisma().$queryRaw<RecurrenceRow[]>`
    SELECT id, tenant_id, pet_id, professional_id, rrule, starts_at, until,
           materialized_until, service_ids
      FROM appointment_recurrences
     WHERE active = true
       AND (materialized_until IS NULL OR materialized_until < ${horizon})
       AND (until IS NULL OR until > ${now})
     LIMIT 200
  `

  let created = 0
  for (const row of rows) {
    try {
      const rule = parseRRule(row.rrule)
      const from = row.materialized_until ?? row.starts_at
      const to = row.until && row.until < horizon ? row.until : horizon
      if (from >= to) continue

      const actor = { tenantId: row.tenant_id }
      // Estritamente depois do horizonte já materializado: `expandOccurrences` inclui
      // a borda, e sem o deslocamento a última ocorrência seria criada duas vezes.
      const after = new Date(from.getTime() + 1)

      for (const startsAt of expandOccurrences(rule, row.starts_at, after, to)) {
        try {
          const booking = await createBooking(actor, {
            petId: row.pet_id,
            professionalId: row.professional_id,
            startsAt,
            items: row.service_ids.map((serviceId) => ({ serviceId })),
            source: 'RECURRENCE',
            acknowledgedAlerts: true,
          })
          await withTenant(row.tenant_id, (tx) =>
            tx.appointment.update({
              where: { id: booking.id },
              data: { recurrenceId: row.id },
            }),
          )
          created += 1
        } catch {
          // RN-15: uma ocorrência conflitante não derruba a série.
        }
      }

      await withTenant(row.tenant_id, (tx) =>
        tx.appointmentRecurrence.update({
          where: { id: row.id },
          data: { materializedUntil: to },
        }),
      )
    } catch (error) {
      logger.error({ err: error, recurrenceId: row.id }, 'falha ao estender recorrência')
    }
  }

  return { created }
}
