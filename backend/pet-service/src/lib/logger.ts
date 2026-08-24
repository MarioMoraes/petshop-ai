import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD pets_03 §10 saem por aqui,
 * no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'pet-service',
  level: loadEnv().LOG_LEVEL,
  // O pet é dado pessoal por associação ao tutor (PRD §9): nome do tutor, telefone,
  // microchip e observações não entram no log.
  redact: ['*.microchip', '*.notes', '*.fullName', '*.phone', '*.phoneMasked'],
})

export type { BusinessMetric } from '@petshop/service-kit'
