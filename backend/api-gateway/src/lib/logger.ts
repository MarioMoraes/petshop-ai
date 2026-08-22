import { pino, type LoggerOptions } from 'pino'
import { loadEnv } from '../env.js'

/** Pino, JSON estruturado (SPEC §8), correlacionado por `request_id` e `tenant_id`. */

export const loggerOptions: LoggerOptions = {
  level: process.env.NODE_ENV === 'test' ? 'silent' : loadEnv().LOG_LEVEL,
  base: { service: 'api-gateway' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.email', '*.phone'],
    censor: '[redacted]',
  },
}

export const logger = pino(loggerOptions)

export function recordMetric(metric: {
  metric: string
  tenantId?: string
  value: number
  unit: string
}): void {
  logger.info(metric, 'métrica de negócio')
}
