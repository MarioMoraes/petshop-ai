import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD relacionamento_crm_08 §10 saem
 * por aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'messaging-service',
  level: loadEnv().LOG_LEVEL,
  // Este serviço manipula o texto que chega ao celular do cliente — com nome, pet,
  // horário e valor devido no mesmo parágrafo. O corpo é o dado mais sensível que
  // passa por aqui, e é justamente o que mais tenta aparecer num log de depuração.
  redact: ['*.body', '*.subject', '*.to', '*.address', '*.phone', '*.email', '*.variables'],
})

export type { BusinessMetric } from '@petshop/service-kit'
