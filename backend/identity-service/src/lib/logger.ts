import { pino, type LoggerOptions } from 'pino'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas de negócio do PRD §10 saem por aqui,
 * no formato `{ metric, tenantId, value, unit }`.
 */

export const loggerOptions: LoggerOptions = {
  level: process.env.NODE_ENV === 'test' ? 'silent' : loadEnv().LOG_LEVEL,
  base: { service: 'identity-service' },
  redact: {
    // PII nunca entra no log, nem por acidente de spread.
    paths: ['*.email', '*.phone', '*.cnpj', 'req.headers.authorization'],
    censor: '[redacted]',
  },
}

/**
 * Logger para código fora de requisição — jobs, publisher de eventos, serviços.
 * O Fastify constrói o dele a partir de `loggerOptions`, com a mesma configuração:
 * passar esta instância como `loggerInstance` especializaria o tipo genérico do app
 * e quebraria o encaixe dos registradores de rota.
 */
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
