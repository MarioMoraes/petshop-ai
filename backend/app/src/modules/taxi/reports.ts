import { withTenant } from '@petshop/db'
import type { TaxiFailureReason, TaxiOperationReport } from '@petshop/shared-types'
import { assertEnabled } from './settings.js'

/**
 * Como o leva-e-traz andou no período — o que o painel do Início mostra (§Métricas do
 * PRD taxi_dog_07).
 *
 * Os três números respondem à mesma pergunta em profundidades diferentes: a aderência
 * diz **se** a promessa está sendo cumprida, as falhas por motivo dizem **por que** ela
 * não é, e a duração por zona diz **onde** a promessa foi mal feita desde o começo — uma
 * janela estreita demais para a zona quebra sem ninguém ter errado na rua.
 *
 * A aderência já era calculada pelo job de varredura, que a escrevia no log e seguia. A
 * conta é a mesma de propósito: dois números de aderência com definições diferentes
 * seriam pior que nenhum. Se um dia ela mudar, muda nos dois lugares.
 *
 * **Recusa quando o módulo está desligado**, como o resto da operação (RN-22). Um
 * petshop que não faz leva-e-traz não deve receber "0% de aderência": zero é resultado
 * ruim, e a ausência do serviço não é resultado nenhum.
 */
export async function taxiOperationReport(
  tenantId: string,
  days: number,
  now: Date = new Date(),
): Promise<TaxiOperationReport> {
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  return withTenant(tenantId, async (tx) => {
    await assertEnabled(tx, tenantId)

    /*
     * A janela conta por `delivered_at`, e não por `window_starts_at`: o período é
     * "corridas que terminaram nestes 30 dias". Uma corrida entregue ontem para uma
     * janela de anteontem pertence a ontem, que é quando ela deu certo ou não.
     */
    const [entregas] = await tx.$queryRaw<{ delivered: bigint; on_time: bigint }[]>`
      SELECT COUNT(*)                                              AS delivered,
             COUNT(*) FILTER (WHERE delivered_at <= window_ends_at) AS on_time
        FROM taxi_rides
       WHERE status = 'DELIVERED'
         AND delivered_at >= ${from} AND delivered_at < ${to}
    `

    const delivered = Number(entregas?.delivered ?? 0)
    const onTime = Number(entregas?.on_time ?? 0)

    /*
     * A falha conta por `updated_at` porque não há coluna de "falhou em": o status é
     * terminal, então a última escrita da linha é o momento em que ela falhou.
     */
    const falhas = await tx.$queryRaw<{ reason: TaxiFailureReason | null; count: bigint }[]>`
      SELECT failure_reason AS reason, COUNT(*) AS count
        FROM taxi_rides
       WHERE status = 'FAILED'
         AND updated_at >= ${from} AND updated_at < ${to}
       GROUP BY failure_reason
       ORDER BY count DESC
    `

    /*
     * A perna é `delivered_at − en_route_at`: o relógio começa quando a van sai, não
     * quando a corrida foi marcada. Corrida sem `en_route_at` é a que alguém encerrou
     * pulando o status na rua, e ela fica de fora em vez de entrar como duração zero.
     *
     * `zone_id` é nulo quando a corrida foi cotada fora de zona, e o LEFT JOIN mantém
     * essas — são justamente as que mais atrasam, e agrupá-las fora esconderia isso.
     */
    const pernas = await tx.$queryRaw<
      { zone_id: string | null; zone_name: string | null; minutes: number; rides: bigint }[]
    >`
      SELECT r.zone_id,
             z.name AS zone_name,
             AVG(EXTRACT(EPOCH FROM (r.delivered_at - r.en_route_at)) / 60) AS minutes,
             COUNT(*) AS rides
        FROM taxi_rides r
        LEFT JOIN taxi_zones z ON z.id = r.zone_id
       WHERE r.status = 'DELIVERED'
         AND r.en_route_at IS NOT NULL
         AND r.delivered_at >= ${from} AND r.delivered_at < ${to}
       GROUP BY r.zone_id, z.name
       ORDER BY minutes DESC
    `

    const legsByZone = pernas.map((row) => ({
      zoneId: row.zone_id,
      zoneName: row.zone_name ?? 'Fora de zona',
      averageMinutes: round1(Number(row.minutes)),
      rides: Number(row.rides),
    }))

    return {
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      delivered,
      onTime,
      adherenceRate: delivered === 0 ? null : Number((onTime / delivered).toFixed(4)),
      failed: falhas.reduce((soma, row) => soma + Number(row.count), 0),
      // `OTHER` é o motivo de quem não achou o próprio motivo na lista; a linha sem
      // motivo nenhum é anterior ao campo, e cai no mesmo balde em vez de sumir.
      failuresByReason: falhas.map((row) => ({
        reason: row.reason ?? ('OTHER' as const),
        count: Number(row.count),
      })),
      averageLegMinutes: mediaPonderada(legsByZone),
      legsByZone,
    }
  })
}

/**
 * A média geral sai das médias por zona, ponderada pelas corridas de cada uma.
 *
 * Fazer a média das médias sem peso daria à zona de duas corridas o mesmo tamanho da de
 * duzentas, e a mais rara costuma ser justamente a mais longa.
 */
function mediaPonderada(legs: { averageMinutes: number; rides: number }[]): number | null {
  const corridas = legs.reduce((soma, leg) => soma + leg.rides, 0)
  if (corridas === 0) return null

  const minutos = legs.reduce((soma, leg) => soma + leg.averageMinutes * leg.rides, 0)
  return round1(minutos / corridas)
}

/** Um decimal: "22,4 min" é precisão de sobra para decidir a largura de uma janela. */
function round1(value: number): number {
  return Number(value.toFixed(1))
}
