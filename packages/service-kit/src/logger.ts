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

export interface ServiceLogger {
  loggerOptions: LoggerOptions
  logger: Logger
  recordMetric: (metric: BusinessMetric) => void
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

  return {
    loggerOptions,
    logger,
    recordMetric(metric: BusinessMetric): void {
      logger.info(metric, 'métrica de negócio')
    },
  }
}
