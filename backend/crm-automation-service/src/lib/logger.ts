import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD relacionamento_crm_08 §10 saem
 * por aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'crm-automation-service',
  level: loadEnv().LOG_LEVEL,
  // Este serviço monta as **variáveis** que vão para dentro da mensagem — nome do
  // tutor, do pet, horário. O corpo em si é montado no messaging-service, mas o
  // insumo passa por aqui.
  redact: ['*.variables', '*.phone', '*.email', '*.body'],
})

export type { BusinessMetric } from '@petshop/service-kit'
