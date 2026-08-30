import { withTenant } from '@petshop/db'
import type { MovementDay } from '@petshop/shared-types'
import type { ActorContext } from '../catalog/actor.js'
import { addDays, zonedDate, zonedMidnight } from './timezone.js'

/**
 * O movimento dos últimos dias — a série que o painel desenha.
 *
 * É contagem, não listagem: `/v1/appointments` corta em 200 linhas (`queries.ts`) e
 * uma semana cheia passaria disso sem avisar, desenhando um gráfico que encolhe
 * justamente no petshop movimentado. Aqui a consulta traz três colunas por
 * agendamento e o resto é soma em memória.
 *
 * A janela é fechada no **fuso do tenant** (RN-19) e os buckets também: um
 * agendamento das 22h em Manaus cai no dia 22h de Manaus, não no dia seguinte de UTC.
 *
 * Dia sem nada volta com zero em vez de sumir da lista. Um gráfico que pula a
 * segunda-feira fechada mente sobre o intervalo entre as barras.
 */
export async function getMovement(
  actor: ActorContext,
  endDate: string,
  days: number,
  timezone: string,
): Promise<{ timezone: string; days: MovementDay[] }> {
  // `endDate` é o último dia **incluído**: a janela vai da meia-noite do primeiro dia
  // até a meia-noite do dia seguinte ao último.
  const firstDate = addDays(endDate, -(days - 1))
  const start = zonedMidnight(firstDate, timezone)
  const end = zonedMidnight(addDays(endDate, 1), timezone)

  const buckets = new Map<string, MovementDay>()
  for (let index = 0; index < days; index += 1) {
    const date = addDays(firstDate, index)
    buckets.set(date, { date, total: 0, completed: 0, noShow: 0, totalCents: 0 })
  }

  const rows = await withTenant(actor.tenantId, (tx) =>
    tx.appointment.findMany({
      where: {
        startsAt: { gte: start, lt: end },
        // Cancelado e remarcado não são movimento: o gráfico responde "quanto
        // trabalho passou por aqui", não "quantas linhas o banco guardou".
        status: { notIn: ['CANCELLED', 'RESCHEDULED'] },
      },
      select: { startsAt: true, status: true, totalCents: true },
    }),
  )

  for (const row of rows) {
    const bucket = buckets.get(zonedDate(row.startsAt, timezone))
    // Só pode faltar na virada do horário de verão, quando o instante limite cai
    // fora da grade de dias; ignorar é melhor que criar uma barra sem lugar no eixo.
    if (!bucket) continue

    bucket.total += 1
    if (row.status === 'COMPLETED') bucket.completed += 1
    if (row.status === 'NO_SHOW') bucket.noShow += 1
    bucket.totalCents += Number(row.totalCents)
  }

  return { timezone, days: [...buckets.values()] }
}
