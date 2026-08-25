import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { matches, parseCron, type CronExpression } from './cron.js'
import { claimLease, recordRun, releaseLease, type JobStatus } from './lease.js'

/**
 * O agendador in-process.
 *
 * Os jobs continuam morando no serviço dono do domínio — quem sabe o que é um no-show é
 * a agenda, não um serviço de relógio. O que este pacote traz é só o **mecanismo**: a
 * grade, a exclusão entre réplicas e o registro da execução. Mesmo corte do
 * `service-kit`: a fábrica é aqui, o catálogo é de quem chama.
 */

export interface JobDefinition {
  /** `dominio.acao`, como as routing keys. Vira a chave do lease e do histórico. */
  name: string
  /** Expressão cron de 5 campos, no fuso do agendador. */
  schedule: string
  run: (now: Date) => Promise<unknown>
  /**
   * Teto de execução. O SLO do §10 dá 10 minutos ao job diário — passou disso, algo
   * está errado e insistir só segura o lease.
   */
  timeoutMs?: number
}

export interface SchedulerLogger {
  info: (payload: Record<string, unknown>, message: string) => void
  warn: (payload: Record<string, unknown>, message: string) => void
  error: (payload: Record<string, unknown>, message: string) => void
  debug: (payload: Record<string, unknown>, message: string) => void
}

export interface SchedulerConfig {
  /** Nome do serviço; entra no `holder` do lease para o log dizer quem está com ele. */
  service: string
  logger: SchedulerLogger
  recordMetric: (metric: { metric: string; value: number; unit: string }) => void
  /** Fuso em que a grade é lida. Padrão: horário de Brasília (SLO do §10). */
  timeZone?: string
  isDisabled: () => boolean
  jobs: JobDefinition[]
}

export interface Scheduler {
  startJobs: () => void
  stopJobs: () => Promise<void>
  /** Roda um job agora, ignorando a grade. Para o teste e para o operador. */
  runJobNow: (name: string, now?: Date) => Promise<unknown>
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const TICK_MS = 60_000

interface CompiledJob extends JobDefinition {
  cron: CronExpression
  timeoutMs: number
}

export function createJobScheduler(config: SchedulerConfig): Scheduler {
  const timeZone = config.timeZone ?? 'America/Sao_Paulo'
  const holder = `${config.service}@${hostname()}#${randomUUID().slice(0, 8)}`

  // A grade é compilada na criação, não no tique: uma expressão inválida deve derrubar
  // a subida do serviço, não falhar de madrugada no primeiro casamento.
  const jobs: CompiledJob[] = config.jobs.map((job) => ({
    ...job,
    cron: parseCron(job.schedule),
    timeoutMs: job.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }))

  let timer: NodeJS.Timeout | null = null
  /** O ciclo em curso. `stopJobs` espera por ele — ver a nota abaixo. */
  let inFlight: Promise<void> = Promise.resolve()
  let stopping = false
  /** Impede que o mesmo minuto rode duas vezes se um tique atrasar. */
  let lastMinute = ''

  async function execute(job: CompiledJob, now: Date): Promise<unknown> {
    const startedAt = new Date()
    let status: JobStatus = 'OK'
    let result: unknown
    let error: string | undefined

    try {
      result = await withTimeout(job.run(now), job.timeoutMs, job.name)
      config.logger.info({ job: job.name, result }, 'job concluído')
    } catch (caught) {
      const timedOut = caught instanceof JobTimeoutError
      status = timedOut ? 'TIMEOUT' : 'FAILED'
      error = caught instanceof Error ? caught.message : String(caught)
      config.logger.error({ job: job.name, err: caught, status }, 'job falhou')
      config.recordMetric({ metric: 'job_failure_total', value: 1, unit: 'count' })
    }

    config.recordMetric({ metric: 'job_run_total', value: 1, unit: 'count' })

    try {
      await recordRun({
        name: job.name,
        startedAt,
        finishedAt: new Date(),
        status,
        result,
        ...(error ? { error } : {}),
      })
    } catch (caught) {
      // Não conseguir gravar o histórico não pode transformar um job bem-sucedido em
      // falha. O log fica como registro de segunda linha.
      config.logger.error({ job: job.name, err: caught }, 'falha ao gravar job_runs')
    }

    if (status !== 'OK') throw new Error(error ?? 'job falhou')
    return result
  }

  async function attempt(job: CompiledJob, now: Date): Promise<void> {
    const lease = await claimLease(job.name, holder, job.timeoutMs)
    if (!lease.acquired) {
      // Caso normal com mais de uma réplica: alguém já pegou. Não é aviso.
      config.logger.debug({ job: job.name, heldBy: lease.heldBy }, 'job já está com outra réplica')
      return
    }

    try {
      await execute(job, now)
    } catch {
      // `execute` já logou e gravou. O laço do tique não pode parar por causa de um job.
    } finally {
      await releaseLease(job.name, holder).catch((caught: unknown) => {
        // O lease expira sozinho; não liberar só atrasa o próximo ciclo.
        config.logger.warn({ job: job.name, err: caught }, 'falha ao liberar o lease')
      })
    }
  }

  async function tick(): Promise<void> {
    if (stopping) return
    const now = new Date()

    // Chave do minuto no fuso do agendador, para o mesmo minuto não rodar duas vezes
    // quando o `setInterval` derivar.
    const minuteKey = now.toISOString().slice(0, 16)
    if (minuteKey === lastMinute) return
    lastMinute = minuteKey

    const due = jobs.filter((job) => matches(job.cron, now, timeZone))
    if (due.length === 0) return

    // Em sequência, não em paralelo: dois jobs do mesmo serviço disputando o pool do
    // Prisma na mesma janela é como as varreduras de madrugada se atrapalham.
    for (const job of due) {
      if (stopping) break
      await attempt(job, now)
    }
  }

  return {
    startJobs(): void {
      if (config.isDisabled()) {
        config.logger.debug({}, 'agendador de jobs desabilitado')
        return
      }
      if (timer) return

      stopping = false
      timer = setInterval(() => {
        inFlight = inFlight.then(() => tick()).catch((caught: unknown) => {
          config.logger.error({ err: caught }, 'falha no ciclo do agendador')
        })
      }, TICK_MS)
      // O agendador não segura o processo de pé: quem decide o encerramento é o servidor.
      timer.unref()

      config.logger.info(
        { timeZone, jobs: jobs.map((job) => `${job.name} (${job.schedule})`) },
        'agendador de jobs no ar',
      )
    },

    /**
     * Para de agendar **e espera o ciclo em curso terminar**.
     *
     * O `server.ts` chama `process.exit(0)` logo depois do shutdown, e um job cortado no
     * meio deixa o lease preso até expirar — além de poder cortar uma varredura entre a
     * escrita no banco e a publicação do evento.
     */
    async stopJobs(): Promise<void> {
      stopping = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await inFlight
    },

    async runJobNow(name: string, now: Date = new Date()): Promise<unknown> {
      const job = jobs.find((candidate) => candidate.name === name)
      if (!job) throw new Error(`Job desconhecido: "${name}"`)
      return execute(job, now)
    },
  }
}

class JobTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`Job "${name}" passou de ${Math.round(ms / 1000)}s e foi interrompido`)
    this.name = 'JobTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JobTimeoutError(name, ms)), ms)
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
