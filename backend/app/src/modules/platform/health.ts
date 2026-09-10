import { getMaintenancePrisma } from '@petshop/db'
import type { DependencyHealth, JobHealth, PlatformHealth } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { checkEvents } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet, getRedis } from '../../shared/redis.js'
import { getJobGrid } from './job-grid-port.js'

/**
 * A saúde da plataforma (MOD-ADMIN-04).
 *
 * **A regra que atravessa o arquivo inteiro: nada aqui lança.** Uma dependência fora do ar
 * vira uma linha vermelha na resposta, nunca um 500 — a tela que observa não pode cair
 * junto com o que ela observa (AC-02). Um painel indisponível justamente quando algo
 * quebrou é pior que nenhum painel, porque some no único momento em que serviria.
 *
 * O caminho oposto também vale: dependência **desligada por configuração** não é falha.
 * O processo sobe sem Redis, sem broker e sem agendador em instalação mínima e em teste;
 * pintar as três de vermelho ali treinaria a equipe a ignorar a cor.
 */

/** Teto de cada sonda. Duas dependências lentas não podem somar dez segundos de tela. */
const PROBE_TIMEOUT_MS = 2_000

/** RN-12: parado é a partir de **três vezes** o intervalo do cron, não de um fixo. */
const STALE_MULTIPLIER = 3

export async function platformHealth(): Promise<PlatformHealth> {
  const cached = await cacheGet<PlatformHealth>(CACHE_KEYS.platformHealth)
  if (cached) return cached

  const [dependencies, jobs, messages] = await Promise.all([
    checkDependencies(),
    checkJobs(),
    queueDepth(),
  ])

  const health: PlatformHealth = {
    checkedAt: new Date().toISOString(),
    dependencies,
    jobs,
    messages,
  }

  /**
   * Quinze segundos, e o TTL é a única invalidação (§10).
   *
   * O painel é aberto por várias pessoas ao mesmo tempo quando algo está acontecendo, que
   * é exatamente quando as sondas custam mais — um Postgres em dificuldade não precisa de
   * uma consulta por F5. Quinze segundos é curto o bastante para que ninguém tome decisão
   * com informação velha.
   */
  await cacheSet(CACHE_KEYS.platformHealth, health, CACHE_TTL_SECONDS.platformHealth)
  return health
}

async function checkDependencies(): Promise<DependencyHealth[]> {
  return Promise.all([checkPostgres(), checkRedis(), checkRabbit(), checkGotenberg()])
}

/**
 * Mede uma sonda sem deixar que ela derrube a resposta.
 *
 * O `Promise.race` com o teto é o que separa "fora do ar" de "pendurado": uma conexão que
 * nunca responde não devolve erro nenhum, e sem o teto o painel ficaria carregando pelo
 * tempo do timeout de rede do sistema operacional.
 */
async function probe(
  name: DependencyHealth['name'],
  run: () => Promise<void>,
): Promise<DependencyHealth> {
  const inicio = Date.now()
  try {
    await Promise.race([run(), rejectAfter(PROBE_TIMEOUT_MS, name)])
    return { name, state: 'UP', latencyMs: Date.now() - inicio, error: null }
  } catch (error) {
    const detalhe = error instanceof Error ? error.message : String(error)
    logger.warn({ err: error, dependency: name }, 'dependência não respondeu à sonda de saúde')
    return { name, state: 'DOWN', latencyMs: Date.now() - inicio, error: detalhe }
  }
}

function rejectAfter(ms: number, name: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} não respondeu em ${ms}ms`)), ms)
    timer.unref()
  })
}

async function checkPostgres(): Promise<DependencyHealth> {
  return probe('postgres', async () => {
    await getMaintenancePrisma().$queryRaw`SELECT 1`
  })
}

async function checkRedis(): Promise<DependencyHealth> {
  if (loadEnv().DISABLE_REDIS) {
    return { name: 'redis', state: 'DISABLED', latencyMs: null, error: null }
  }
  return probe('redis', async () => {
    const redis = getRedis()
    if (!redis) throw new Error('cliente de cache indisponível')
    await redis.ping()
  })
}

async function checkRabbit(): Promise<DependencyHealth> {
  const inicio = Date.now()
  const resultado = await checkEvents()
  if (resultado.state === 'DISABLED') {
    return { name: 'rabbitmq', state: 'DISABLED', latencyMs: null, error: null }
  }
  return {
    name: 'rabbitmq',
    state: resultado.state,
    latencyMs: Date.now() - inicio,
    error: resultado.error ?? null,
  }
}

/**
 * O Gotenberg é o único que se pergunta por HTTP, e o único cuja ausência é normal.
 *
 * Sem `GOTENBERG_URL` o produto continua inteiro, menos a emissão de PDF — é a mesma
 * degradação que o `isConfigured()` de `@petshop/pdf` já trata. `DISABLED` diz isso; um
 * vermelho diria que algo quebrou.
 */
async function checkGotenberg(): Promise<DependencyHealth> {
  const url = loadEnv().GOTENBERG_URL
  if (!url) return { name: 'gotenberg', state: 'DISABLED', latencyMs: null, error: null }

  return probe('gotenberg', async () => {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`respondeu ${response.status}`)
  })
}

interface RunRow {
  name: string
  started_at: Date
  finished_at: Date
  status: 'OK' | 'FAILED' | 'TIMEOUT'
  error: string | null
}

interface LeaseRow {
  name: string
  holder: string
  leased_at: Date
  lease_until: Date
}

/**
 * A grade cruzada com o histórico (AC-01, AC-03 e AC-04).
 *
 * Três consultas para toda a grade, e não três por job: a última execução de cada nome, a
 * última execução **bem-sucedida** de cada nome e os leases. `DISTINCT ON` é o que
 * resolve as duas primeiras numa passada pelo índice `(name, started_at DESC)`.
 *
 * As duas listas existem separadas porque respondem a perguntas diferentes: a última
 * execução diz se o job está falhando **agora**, e a última bem-sucedida diz há quanto
 * tempo ele não faz o trabalho. Um job que falha de hora em hora tem execução recente e
 * pode estar parado há dias.
 */
async function checkJobs(): Promise<JobHealth[]> {
  const agora = new Date()
  const grade = getJobGrid().describe(agora)
  if (grade.length === 0) return []

  const prisma = getMaintenancePrisma()
  const [ultimas, ultimasOk, leases] = await Promise.all([
    prisma.$queryRaw<RunRow[]>`
      SELECT DISTINCT ON (name) name, started_at, finished_at, status::text, error
        FROM job_runs
       ORDER BY name, started_at DESC
    `,
    prisma.$queryRaw<RunRow[]>`
      SELECT DISTINCT ON (name) name, started_at, finished_at, status::text, error
        FROM job_runs
       WHERE status = 'OK'
       ORDER BY name, started_at DESC
    `,
    prisma.$queryRaw<LeaseRow[]>`SELECT name, holder, leased_at, lease_until FROM job_leases`,
  ])

  const porNome = new Map(ultimas.map((row) => [row.name, row]))
  const okPorNome = new Map(ultimasOk.map((row) => [row.name, row]))
  const leasePorNome = new Map(leases.map((row) => [row.name, row]))

  return grade.map((job) => {
    const ultima = porNome.get(job.name)
    const ultimaOk = okPorNome.get(job.name)
    const lease = leasePorNome.get(job.name)

    return {
      name: job.name,
      schedule: job.schedule,
      state: jobState(agora, job.intervalMs, ultima, ultimaOk),
      lastRunAt: ultima?.started_at.toISOString() ?? null,
      lastStatus: ultima?.status ?? null,
      lastDurationMs: ultima
        ? ultima.finished_at.getTime() - ultima.started_at.getTime()
        : null,
      lastError: ultima?.error ?? null,
      nextRunAt: job.nextRunAt?.toISOString() ?? null,
      stuckLease: stuckLease(agora, lease, ultima),
    }
  })
}

function jobState(
  agora: Date,
  intervalMs: number | null,
  ultima: RunRow | undefined,
  ultimaOk: RunRow | undefined,
): JobHealth['state'] {
  if (!ultima) return 'NEVER_RUN'
  if (ultima.status !== 'OK') return 'FAILING'

  /**
   * Sem intervalo conhecido não há alarme.
   *
   * `intervalMs` é nulo quando a expressão não casa duas vezes dentro do horizonte de
   * previsão — um job anual, por exemplo. Chamar isso de parado seria alarmar todo dia por
   * uma grade que está correta.
   */
  if (!intervalMs || !ultimaOk) return 'OK'

  const parado = agora.getTime() - ultimaOk.started_at.getTime() > intervalMs * STALE_MULTIPLIER
  return parado ? 'STALE' : 'OK'
}

/**
 * O lease preso (AC-04).
 *
 * `lease_until` no passado **e** nenhuma execução iniciada depois de o lease ser tomado. A
 * segunda condição é o que separa o sintoma do funcionamento normal: todo job libera o
 * lease no fim, deixando `lease_until` no passado — o que não é normal é isso ter
 * acontecido sem que a execução correspondente aparecesse em `job_runs`, que é a marca da
 * réplica que morreu no meio.
 */
function stuckLease(
  agora: Date,
  lease: LeaseRow | undefined,
  ultima: RunRow | undefined,
): JobHealth['stuckLease'] {
  if (!lease) return null
  if (lease.lease_until.getTime() > agora.getTime()) return null
  if (ultima && ultima.started_at.getTime() >= lease.leased_at.getTime()) return null
  return { holder: lease.holder, leaseUntil: lease.lease_until.toISOString() }
}

/**
 * A profundidade da fila de saída, por status.
 *
 * **É a tabela `messages`, e não a fila do RabbitMQ.** O broker transporta eventos de
 * domínio; o que se acumula quando o envio para de funcionar é a fila de saída do
 * MOD-NOTIF, que é uma tabela. Os cinco status são sempre devolvidos, mesmo zerados: uma
 * linha que some quando chega a zero faz o painel parecer quebrado justamente no dia bom.
 */
const BACKLOG_STATUSES = ['QUEUED', 'SCHEDULED', 'SENDING', 'FAILED', 'DEAD'] as const

async function queueDepth(): Promise<PlatformHealth['messages']> {
  const rows = await getMaintenancePrisma().message.groupBy({
    by: ['status'],
    where: { status: { in: [...BACKLOG_STATUSES] } },
    _count: { _all: true },
  })

  const contagem = new Map(rows.map((row) => [row.status as string, row._count._all]))
  return BACKLOG_STATUSES.map((status) => ({ status, count: contagem.get(status) ?? 0 }))
}
