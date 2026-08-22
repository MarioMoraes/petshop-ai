import { pino, type LoggerOptions } from 'pino'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD tutores_02 §10 saem por aqui,
 * no formato `{ metric, tenantId, value, unit }`.
 */

export const loggerOptions: LoggerOptions = {
  level: process.env.NODE_ENV === 'test' ? 'silent' : loadEnv().LOG_LEVEL,
  base: { service: 'tutor-service' },
  redact: {
    // O serviço inteiro gira em torno de PII: a lista aqui é mais larga que a do
    // identity-service de propósito.
    paths: [
      '*.email',
      '*.phone',
      '*.phoneAlt',
      '*.cpf',
      '*.cnpj',
      '*.fullName',
      '*.socialName',
      '*.street',
      '*.notes',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
}

export const logger = pino(loggerOptions)

export interface BusinessMetric {
  metric: string
  tenantId?: string
  value: number
  unit: string
}

export function recordMetric(metric: BusinessMetric): void {
  logger.info(metric, 'métrica de negócio')
}
