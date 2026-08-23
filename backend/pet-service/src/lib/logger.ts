import { pino, type LoggerOptions } from 'pino'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD pets_03 §10 saem por aqui,
 * no formato `{ metric, tenantId, value, unit }`.
 */

export const loggerOptions: LoggerOptions = {
  level: process.env.NODE_ENV === 'test' ? 'silent' : loadEnv().LOG_LEVEL,
  base: { service: 'pet-service' },
  redact: {
    // O pet é dado pessoal por associação ao tutor (PRD §9): nome do tutor,
    // telefone, microchip e observações não entram no log.
    paths: [
      '*.microchip',
      '*.notes',
      '*.fullName',
      '*.phone',
      '*.phoneMasked',
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
