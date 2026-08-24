import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas de negócio do PRD §10 saem por aqui,
 * no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'identity-service',
  level: loadEnv().LOG_LEVEL,
  // PII nunca entra no log, nem por acidente de spread.
  redact: ['*.email', '*.phone', '*.cnpj'],
})

export type { BusinessMetric } from '@petshop/service-kit'
