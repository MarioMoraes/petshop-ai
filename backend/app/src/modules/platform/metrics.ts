import { Prisma, getMaintenancePrisma } from '@petshop/db'
import type {
  MetricBucketSize,
  PlatformMetricPoint,
  PlatformMetricSeries,
  PlatformMetricsQuery,
} from '@petshop/shared-types'
import { drainMetrics, logger, recordMetric } from '../../shared/logger.js'
import { invalid } from './errors.js'

/**
 * O coletor de métricas (MOD-ADMIN-05).
 *
 * As 51 métricas do produto já saíam em log estruturado, e log responde "o que aconteceu
 * às 14h07" — nunca "isso está piorando desde terça". O que falta entre as duas perguntas
 * é uma série, e é ela que este arquivo escreve.
 *
 * **O caminho quente não toca o banco** (RN-07). `recordMetric` soma num acumulador em
 * memória do `service-kit`, e o job drena de cinco em cinco minutos. As duas alternativas
 * foram recusadas por medida: uma escrita por métrica colocaria uma ida ao banco dentro de
 * toda operação medida, e parsear o log acoplaria a observabilidade ao formato do
 * transporte — além de obrigar o processo a ler em disco o que ele mesmo acabou de
 * escrever.
 *
 * **O preço é declarado** (RN-08): um deploy no meio de uma janela perde até cinco minutos
 * de telemetria. Para contagem de tendência isso não muda nenhuma decisão; para dado de
 * negócio seria inaceitável — e nenhum dado de negócio passa por aqui.
 */

const FIVE_MIN_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60 * 1000

/** Os baldes de cinco minutos vivem trinta dias; a série diária, treze meses (AC-04). */
export const FIVE_MIN_RETENTION_DAYS = 30
export const DAY_RETENTION_DAYS = 396

/** Sem `from`/`to`, a consulta abre nas últimas 24 horas. */
const DEFAULT_WINDOW_MS = DAY_MS
const MAX_WINDOW_MS = DAY_RETENTION_DAYS * DAY_MS

/**
 * Drena o acumulador para a série (AC-01).
 *
 * O bucket sai de `since`, o instante da primeira amostra da janela, e **não** do relógio
 * da execução — que é por isso que esta é a única função da grade sem parâmetro `now`. Um
 * job atrasado por dez minutos jogaria dez minutos de amostra no balde errado, e a série
 * mostraria um pico onde houve uma pausa do agendador.
 */
export async function rollUpMetrics(): Promise<{ keys: number; samples: number }> {
  const inicio = Date.now()
  const linhas = drainMetrics()
  if (linhas.length === 0) return { keys: 0, samples: 0 }

  const values = linhas.map((linha) => {
    const bucket = new Date(Math.floor(linha.since.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS)
    return Prisma.sql`(
      ${linha.metric}, ${linha.tenantId}::uuid, ${bucket}, 'FIVE_MIN'::"MetricResolution",
      ${linha.sum}, ${linha.count}, ${linha.min}, ${linha.max}, ${linha.p95}
    )`
  })

  /**
   * **`sum = sum + excluded.sum`, e não `sum = excluded.sum`** (RN-09).
   *
   * Duas réplicas drenam acumuladores diferentes do mesmo balde, e cada uma chega aqui com
   * metade do movimento. Um `UPDATE SET sum =` faria a última a chegar apagar a primeira,
   * e o gráfico mostraria metade do tráfego — sem erro nenhum no log.
   *
   * `p95` é o que não se soma: fica com o maior dos dois, que é aproximação declarada. O
   * exato exigiria guardar as amostras das duas réplicas, e o acumulador existe
   * justamente para não guardá-las.
   */
  await getMaintenancePrisma().$executeRaw(Prisma.sql`
    INSERT INTO platform_metrics (metric, tenant_id, bucket, resolution, sum, count, min, max, p95)
    VALUES ${Prisma.join(values, ',')}
    ON CONFLICT (metric, resolution, bucket, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET
      sum   = platform_metrics.sum + EXCLUDED.sum,
      count = platform_metrics.count + EXCLUDED.count,
      min   = LEAST(platform_metrics.min, EXCLUDED.min),
      max   = GREATEST(platform_metrics.max, EXCLUDED.max),
      p95   = GREATEST(platform_metrics.p95, EXCLUDED.p95)
  `)

  const samples = linhas.reduce((soma, linha) => soma + linha.count, 0)

  /**
   * O coletor mede a si mesmo, e a métrica cai na janela **seguinte** — ela é registrada
   * depois da drenagem. É o número que responde se o coletor virou o gargalo que ele
   * deveria observar.
   */
  recordMetric({
    metric: 'platform_metric_rollup_duration',
    value: Date.now() - inicio,
    unit: 'ms',
  })

  logger.debug({ keys: linhas.length, samples }, 'métricas consolidadas')
  return { keys: linhas.length, samples }
}

/**
 * Consolida o que passou de trinta dias em baldes de um dia, e expurga o resto (AC-04).
 *
 * A série diária fica treze meses porque a pergunta que ela responde é "como está
 * dezembro comparado com o dezembro passado" — treze, e não doze, para que o mês corrente
 * ainda encontre o seu par do ano anterior.
 */
export async function compactMetrics(now: Date = new Date()): Promise<{
  compacted: number
  removed: number
  expired: number
}> {
  const corte = new Date(now.getTime() - FIVE_MIN_RETENTION_DAYS * DAY_MS)
  const expiracao = new Date(now.getTime() - DAY_RETENTION_DAYS * DAY_MS)
  const prisma = getMaintenancePrisma()

  /**
   * A consolidação vem antes do apagamento, e o `ON CONFLICT` do mesmo jeito do roll-up:
   * uma passada interrompida entre as duas instruções deixa o dia já somado, e a próxima
   * execução somaria de novo se o conflito sobrescrevesse em vez de acumular. Aqui ele
   * **sobrescreve** de propósito — o agregado do dia é recalculado a partir de todas as
   * linhas de cinco minutos que ainda existem, então repetir é idempotente.
   */
  const compacted = await prisma.$executeRaw`
    INSERT INTO platform_metrics (metric, tenant_id, bucket, resolution, sum, count, min, max, p95)
    SELECT metric, tenant_id, date_trunc('day', bucket), 'DAY'::"MetricResolution",
           SUM(sum), SUM(count), MIN(min), MAX(max), MAX(p95)
      FROM platform_metrics
     WHERE resolution = 'FIVE_MIN' AND bucket < ${corte}
     GROUP BY metric, tenant_id, date_trunc('day', bucket)
    ON CONFLICT (metric, resolution, bucket, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET
      sum   = EXCLUDED.sum,
      count = EXCLUDED.count,
      min   = EXCLUDED.min,
      max   = EXCLUDED.max,
      p95   = EXCLUDED.p95
  `

  const removed = await prisma.$executeRaw`
    DELETE FROM platform_metrics WHERE resolution = 'FIVE_MIN' AND bucket < ${corte}
  `

  const expired = await prisma.$executeRaw`
    DELETE FROM platform_metrics WHERE resolution = 'DAY' AND bucket < ${expiracao}
  `

  logger.info({ compacted, removed, expired }, 'série de métricas compactada')
  return { compacted, removed, expired }
}

interface SeriesRow {
  bucket: Date
  tenant_id: string | null
  sum: string
  count: bigint
  min: string
  max: string
  p95: string
}

/**
 * A série no intervalo pedido (AC-02).
 *
 * **O balde servido não é necessariamente o guardado.** Trinta dias em baldes de cinco
 * minutos são 8.640 pontos, que é uma lista e não um gráfico; e nada com mais de trinta
 * dias existe em cinco minutos, porque a compactação já passou por ali. A escada é:
 *
 * | Janela pedida | Balde servido | De onde sai |
 * |---|---|---|
 * | até 2 dias | 5 minutos | linhas `FIVE_MIN` |
 * | 2 a 30 dias | 1 hora | linhas `FIVE_MIN`, agregadas na consulta |
 * | acima de 30 dias | 1 dia | linhas `DAY` |
 */
export async function queryMetrics(query: PlatformMetricsQuery): Promise<PlatformMetricSeries> {
  const to = query.to ? new Date(query.to) : new Date()
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_MS)

  if (from.getTime() > to.getTime()) throw invalid('O início do período é posterior ao fim')
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw invalid(`O período máximo de consulta é de ${DAY_RETENTION_DAYS} dias`)
  }

  const janela = to.getTime() - from.getTime()
  const antigo = from.getTime() < Date.now() - FIVE_MIN_RETENTION_DAYS * DAY_MS

  const bucketSize: MetricBucketSize = antigo ? 'DAY' : janela > 2 * DAY_MS ? 'HOUR' : 'FIVE_MIN'
  const resolucao = bucketSize === 'DAY' ? 'DAY' : 'FIVE_MIN'

  /**
   * O `date_trunc` recebe a unidade por literal, escolhida do enum acima — nunca por
   * parâmetro vindo da consulta. É a única parte desta SQL que não é parametrizada, e a
   * lista fechada é o que a mantém segura.
   */
  const balde =
    bucketSize === 'HOUR' ? Prisma.sql`date_trunc('hour', bucket)` : Prisma.sql`bucket`

  const porTenant = query.groupBy === 'tenant'
  const chaveTenant = porTenant ? Prisma.sql`tenant_id` : Prisma.sql`NULL::uuid`

  const rows = await getMaintenancePrisma().$queryRaw<SeriesRow[]>(Prisma.sql`
    SELECT ${balde} AS bucket,
           ${chaveTenant} AS tenant_id,
           SUM(sum) AS sum, SUM(count) AS count,
           MIN(min) AS min, MAX(max) AS max, MAX(p95) AS p95
      FROM platform_metrics
     WHERE metric = ${query.metric}
       AND resolution = ${resolucao}::"MetricResolution"
       AND bucket >= ${from} AND bucket <= ${to}
     GROUP BY 1, 2
     ORDER BY 1 ASC
  `)

  return {
    metric: query.metric,
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSize,
    groupBy: query.groupBy,
    points: rows.map(
      (row): PlatformMetricPoint => ({
        bucket: row.bucket.toISOString(),
        tenantId: row.tenant_id,
        sum: Number(row.sum),
        count: Number(row.count),
        min: Number(row.min),
        max: Number(row.max),
        p95: Number(row.p95),
      }),
    ),
  }
}
