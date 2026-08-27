import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { logger, recordMetric } from '../../lib/logger.js'

/**
 * Os dois jobs do Taxi Dog (§10 do PRD).
 *
 * Como os da agenda, ambos varrem **todos os tenants**: a consulta que descobre o que
 * fazer usa `app_maintenance` (com BYPASSRLS) e o trabalho em si roda dentro de
 * `withTenant`. Descobrir é cross-tenant; agir nunca é.
 *
 * Nenhum dos dois **muda** uma corrida — os dois só relatam. É deliberado: uma corrida
 * atrasada continua sendo uma corrida que precisa acontecer, e marcá-la
 * automaticamente como falha tiraria da recepção a chance de ligar para o tutor. A
 * agenda pode marcar no-show sozinha porque o horário passou e acabou; a corrida não,
 * porque o pet ainda está em algum lugar.
 */

interface UnassignedRow {
  id: string
  tenant_id: string
  window_starts_at: Date
  alert_hours: number
}

/**
 * `taxi.unassigned-alert` — a janela se aproxima e ninguém foi designado.
 *
 * O índice parcial `idx_taxi_rides_unassigned` existe exatamente para esta consulta.
 * O limite vem de `taxi_settings.unassigned_alert_hours` (12h por padrão) porque
 * quanto tempo é "cedo demais para se preocupar" muda com o tamanho da operação.
 */
export async function alertUnassignedRides(
  now: Date = new Date(),
): Promise<{ pending: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<UnassignedRow[]>`
    SELECT r.id, r.tenant_id, r.window_starts_at,
           COALESCE(s.unassigned_alert_hours, 12) AS alert_hours
      FROM taxi_rides r
      JOIN taxi_settings s ON s.tenant_id = r.tenant_id
     WHERE r.driver_id IS NULL
       AND r.status = 'REQUESTED'
       AND s.enabled = true
       AND r.window_starts_at > ${now}
       AND r.window_starts_at < ${now} + (COALESCE(s.unassigned_alert_hours, 12) || ' hours')::interval
     ORDER BY r.window_starts_at ASC
     LIMIT 500
  `

  // Agrupa por tenant: um alerta com a contagem é acionável; 40 alertas de uma linha
  // cada ensinam a recepção a ignorar o painel.
  const byTenant = new Map<string, number>()
  for (const row of rows) {
    byTenant.set(row.tenant_id, (byTenant.get(row.tenant_id) ?? 0) + 1)
  }

  for (const [tenantId, pending] of byTenant) {
    logger.warn(
      { tenantId, pending, earliest: rows.find((r) => r.tenant_id === tenantId)?.window_starts_at },
      'corridas sem motorista perto da janela',
    )
    recordMetric({ metric: 'taxi_unassigned_near_window', value: pending, unit: 'count' })
  }

  return { pending: rows.length }
}

interface OverdueRow {
  id: string
  tenant_id: string
  status: string
  window_ends_at: Date
}

/**
 * `taxi.overdue-sweeper` — a janela venceu e a corrida não terminou.
 *
 * Alimenta `taxi_window_adherence_rate`, que é a métrica principal do módulo: a
 * janela é a promessa feita ao tutor, e o que este job mede é quantas vezes ela foi
 * quebrada.
 *
 * **Não muda status.** Uma coleta atrasada ainda é uma coleta que vai acontecer; quem
 * decide se virou `FAILED` é o motorista, que está na porta.
 */
export async function sweepOverdueRides(
  now: Date = new Date(),
): Promise<{ overdue: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<OverdueRow[]>`
    SELECT id, tenant_id, status, window_ends_at
      FROM taxi_rides
     WHERE status IN ('ASSIGNED','EN_ROUTE','ARRIVED','ONBOARD')
       AND window_ends_at < ${now}
     ORDER BY window_ends_at ASC
     LIMIT 500
  `

  const byTenant = new Map<string, OverdueRow[]>()
  for (const row of rows) {
    const list = byTenant.get(row.tenant_id) ?? []
    list.push(row)
    byTenant.set(row.tenant_id, list)
  }

  for (const [tenantId, overdue] of byTenant) {
    const worstMin = Math.max(
      ...overdue.map((row) => (now.getTime() - row.window_ends_at.getTime()) / 60_000),
    )
    logger.warn({ tenantId, overdue: overdue.length }, 'corridas com janela vencida')
    recordMetric({ metric: 'taxi_overdue_rides', value: overdue.length, unit: 'count' })
    recordMetric({ metric: 'taxi_late_delivery_min', value: Math.round(worstMin), unit: 'minutes' })
  }

  return { overdue: rows.length }
}

/**
 * A taxa de aderência à janela do dia anterior, por tenant.
 *
 * Roda uma vez ao dia porque é medida de fechamento, não de operação: no meio do dia
 * a conta ainda está aberta e o número só assustaria sem informar.
 */
export async function measureWindowAdherence(
  now: Date = new Date(),
): Promise<{ tenants: number }> {
  const from = new Date(now.getTime() - 24 * 3_600_000)

  const rows = await getMaintenancePrisma().$queryRaw<
    { tenant_id: string; delivered: bigint; on_time: bigint }[]
  >`
    SELECT tenant_id,
           COUNT(*) AS delivered,
           COUNT(*) FILTER (WHERE delivered_at <= window_ends_at) AS on_time
      FROM taxi_rides
     WHERE status = 'DELIVERED'
       AND delivered_at >= ${from} AND delivered_at < ${now}
     GROUP BY tenant_id
  `

  for (const row of rows) {
    const delivered = Number(row.delivered)
    if (delivered === 0) continue
    recordMetric({
      metric: 'taxi_window_adherence_rate',
      value: Number((Number(row.on_time) / delivered).toFixed(4)),
      unit: 'ratio',
    })
  }

  return { tenants: rows.length }
}

/** Reexportado para os testes exercitarem o caminho de tenant sem passar pelo cron. */
export { withTenant }
