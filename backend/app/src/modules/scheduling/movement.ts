import { withTenant } from '@petshop/db'
import type { BookingSources, MovementDay, NoShowReport } from '@petshop/shared-types'
import type { ActorContext } from '../schedule-catalog/actor.js'
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

/**
 * De onde vieram os agendamentos do período — o KPI do Portal no painel do Início.
 *
 * Difere de `getMovement` em três coisas, e nenhuma é detalhe. Conta por **data de
 * criação**, não pela do atendimento: a pergunta é por onde o pedido entrou, e um banho
 * marcado hoje para o mês que vem já é self-service hoje. **Inclui cancelado e
 * remarcado**, que o movimento exclui: eles não são trabalho executado, mas foram
 * pedidos, e é o pedido que se está medindo. E a janela é corrida — 30 dias para trás a
 * partir de agora —, sem grade de dias, porque o número é uma proporção e não uma série.
 */
export async function getBookingSources(
  tenantId: string,
  days: number,
  now: Date = new Date(),
): Promise<BookingSources> {
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const [total, portal] = await withTenant(tenantId, (tx) =>
    Promise.all([
      tx.appointment.count({ where: { createdAt: { gte: from, lt: to } } }),
      tx.appointment.count({
        where: { createdAt: { gte: from, lt: to }, source: 'PORTAL' },
      }),
    ]),
  )

  return { days, from: from.toISOString(), to: to.toISOString(), total, portal }
}

/**
 * As faltas do período — o "prejuízo das faltas" do PRD financeiro_tutor_05 §10.
 *
 * Mora na agenda, e não no financeiro, porque a falta é um estado do agendamento e o
 * valor perdido é o `total_cents` dele: não existe lançamento para o que não aconteceu.
 * A metade "quanto foi cobrado" do indicador não está aqui por não ter de onde sair —
 * `markNoShow` calcula a multa e a publica em `agendamento.no_show`, mas nenhum
 * consumidor a lança como `NO_SHOW_FEE`. Somar lançamentos que nunca nascem daria um
 * zero com cara de resultado.
 *
 * Conta pelo `starts_at`, na janela corrida que termina agora: a falta de amanhã ainda
 * não é falta.
 */
export async function getNoShows(
  tenantId: string,
  days: number,
  now: Date = new Date(),
): Promise<NoShowReport> {
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const result = await withTenant(tenantId, (tx) =>
    tx.appointment.aggregate({
      where: { status: 'NO_SHOW', startsAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
  )

  return {
    days,
    from: from.toISOString(),
    to: to.toISOString(),
    count: result._count._all,
    totalCents: Number(result._sum.totalCents ?? 0),
  }
}
