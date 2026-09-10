import { pino, type Logger, type LoggerOptions } from 'pino'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas de negócio dos PRDs §10 saem por
 * aqui, no formato `{ metric, tenantId, value, unit }`.
 */

/**
 * Redações que valem para qualquer serviço. O header de autorização entra aqui e não
 * na lista de cada um porque esquecê-lo vaza credencial, não PII — e a diferença
 * entre os dois é quem precisa ser avisado quando acontece.
 */
export const ALWAYS_REDACTED = ['req.headers.authorization'] as const

export interface BusinessMetric {
  metric: string
  tenantId?: string
  value: number
  unit: string
}

export interface LoggerConfig {
  /** Vai em `base.service`; é como se filtra um serviço no agregador. */
  service: string
  level: LoggerOptions['level']
  /**
   * Caminhos de PII a mascarar, **acrescentados** a `ALWAYS_REDACTED`. A lista é
   * própria de cada serviço: o que é dado sensível no tutor-service (CPF, endereço)
   * não existe no gateway, e o inverso também vale.
   */
  redact?: readonly string[]
}

/**
 * O que o coletor do MOD-ADMIN-05 tira do acumulador a cada drenagem.
 *
 * Uma linha por `(metric, tenantId)`, com a janela a que ela se refere — `since` é o
 * instante da **primeira** amostra depois da última drenagem, e é ele que decide em que
 * bucket a linha cai. Assim um job atrasado não joga dez minutos de amostra no bucket de
 * agora: ele os joga no bucket em que a coleta começou.
 */
export interface MetricSample {
  metric: string
  tenantId: string | null
  sum: number
  count: number
  min: number
  max: number
  p95: number
  since: Date
}

export interface ServiceLogger {
  loggerOptions: LoggerOptions
  logger: Logger
  recordMetric: (metric: BusinessMetric) => void
  /**
   * Esvazia o acumulador e devolve o que havia (MOD-ADMIN-05, AC-05).
   *
   * Chamado pelo job de roll-up, de cinco em cinco minutos. **Esvaziar faz parte**: o que
   * sai daqui já não está mais em memória, e uma falha do job perde a janela — que é o
   * preço declarado no RN-08. Persistir a cada `recordMetric` custaria uma escrita por
   * métrica no caminho quente, e telemetria não paga esse preço.
   */
  drainMetrics: () => MetricSample[]
}

export function createLogger(config: LoggerConfig): ServiceLogger {
  const loggerOptions: LoggerOptions = {
    // Teste não escreve log: a suíte roda com o processo em silêncio e o que
    // interessa é a asserção, não a saída.
    level: process.env.NODE_ENV === 'test' ? 'silent' : config.level,
    base: { service: config.service },
    redact: {
      paths: [...ALWAYS_REDACTED, ...(config.redact ?? [])],
      censor: '[redacted]',
    },
  }

  /**
   * Logger para código fora de requisição — jobs, publicador de eventos, serviços.
   * O Fastify constrói o dele a partir de `loggerOptions`, com a mesma configuração:
   * passar esta instância como `loggerInstance` especializaria o tipo genérico do app
   * e quebraria o encaixe dos registradores de rota.
   */
  const logger = pino(loggerOptions)

  /**
   * O acumulador em memória (RN-07).
   *
   * **Somar aqui é o que torna o coletor mais barato que o que ele mede.** A alternativa
   * era o job parsear o log — o que acoplaria a observabilidade ao formato do transporte
   * e obrigaria a ler em disco o que o processo acabou de escrever — ou uma escrita por
   * métrica, que colocaria uma ida ao banco dentro de toda operação medida.
   *
   * Os dois tetos abaixo existem porque este objeto vive no processo e ninguém o vigia:
   * um nome de métrica montado com um id, ou uma instalação com milhares de tenants
   * ativos ao mesmo tempo, encheriam a memória entre duas drenagens.
   */
  const MAX_KEYS = 2_000
  const MAX_SAMPLES = 256

  interface Accumulated {
    metric: string
    tenantId: string | null
    sum: number
    count: number
    min: number
    max: number
    /** Amostra limitada, para o p95. Ver `sample()`. */
    samples: number[]
    since: Date
  }

  const acumulado = new Map<string, Accumulated>()
  let derrubadas = 0

  /**
   * Reservatório de tamanho fixo (algoritmo R).
   *
   * Guardar toda amostra daria um p95 exato e uma memória sem teto — e o pico de tráfego,
   * que é quando o p95 interessa, é justamente quando a lista cresceria mais. Com 256
   * amostras por chave, o p95 é aproximado e o custo é conhecido.
   */
  function sample(entry: Accumulated, value: number): void {
    if (entry.samples.length < MAX_SAMPLES) {
      entry.samples.push(value)
      return
    }
    const posicao = Math.floor(Math.random() * entry.count)
    if (posicao < MAX_SAMPLES) entry.samples[posicao] = value
  }

  function percentil95(samples: number[]): number {
    if (samples.length === 0) return 0
    const ordenado = [...samples].sort((a, b) => a - b)
    const indice = Math.max(0, Math.ceil(ordenado.length * 0.95) - 1)
    return ordenado[indice] ?? 0
  }

  return {
    loggerOptions,
    logger,

    recordMetric(metric: BusinessMetric): void {
      logger.info(metric, 'métrica de negócio')

      const tenantId = metric.tenantId ?? null
      const chave = `${metric.metric}\u0000${tenantId ?? ''}`
      const existente = acumulado.get(chave)

      if (!existente) {
        if (acumulado.size >= MAX_KEYS) {
          // Não derruba a métrica em silêncio: o contador vira log na drenagem, que é
          // onde alguém está olhando para números.
          derrubadas += 1
          return
        }
        acumulado.set(chave, {
          metric: metric.metric,
          tenantId,
          sum: metric.value,
          count: 1,
          min: metric.value,
          max: metric.value,
          samples: [metric.value],
          since: new Date(),
        })
        return
      }

      existente.sum += metric.value
      existente.count += 1
      if (metric.value < existente.min) existente.min = metric.value
      if (metric.value > existente.max) existente.max = metric.value
      sample(existente, metric.value)
    },

    drainMetrics(): MetricSample[] {
      const linhas = [...acumulado.values()].map((entry) => ({
        metric: entry.metric,
        tenantId: entry.tenantId,
        sum: entry.sum,
        count: entry.count,
        min: entry.min,
        max: entry.max,
        p95: percentil95(entry.samples),
        since: entry.since,
      }))

      acumulado.clear()
      if (derrubadas > 0) {
        logger.warn(
          { derrubadas, teto: MAX_KEYS },
          'métricas descartadas por excesso de chaves distintas no acumulador',
        )
        derrubadas = 0
      }

      return linhas
    },
  }
}
