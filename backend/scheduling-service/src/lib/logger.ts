import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD agenda_operacao_06 §10 saem
 * por aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'scheduling-service',
  level: loadEnv().LOG_LEVEL,
  // A agenda encosta em tutor e pet o tempo todo, e `notes` é campo livre que o §9
  // classifica como risco de dado sensível.
  redact: ['*.notes', '*.cancelReason', '*.fullName', '*.phone', '*.phoneMasked'],
})

export type { BusinessMetric } from '@petshop/service-kit'
