import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD tutores_02 §10 saem por aqui,
 * no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'tutor-service',
  level: loadEnv().LOG_LEVEL,
  // O serviço inteiro gira em torno de PII: a lista aqui é mais larga que a dos
  // outros de propósito.
  redact: [
    '*.email',
    '*.phone',
    '*.phoneAlt',
    '*.cpf',
    '*.cnpj',
    '*.fullName',
    '*.socialName',
    '*.street',
    '*.notes',
  ],
})

export type { BusinessMetric } from '@petshop/service-kit'
