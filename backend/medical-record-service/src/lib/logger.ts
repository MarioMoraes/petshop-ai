import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD prontuario_04 §10 saem por
 * aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'medical-record-service',
  level: loadEnv().LOG_LEVEL,
  // O pet é dado pessoal por associação ao tutor (PRD §9), e o conteúdo clínico —
  // reação e posologia — é dado sensível por si só.
  redact: ['*.reaction', '*.instructions', '*.notes', '*.fullName', '*.phone', '*.phoneMasked'],
})

export type { BusinessMetric } from '@petshop/service-kit'
