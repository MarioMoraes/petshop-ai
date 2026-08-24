import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/** Pino, JSON estruturado (SPEC §8), correlacionado por `request_id` e `tenant_id`. */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'api-gateway',
  level: loadEnv().LOG_LEVEL,
  redact: ['req.headers.cookie', '*.email', '*.phone'],
})

export type { BusinessMetric } from '@petshop/service-kit'
