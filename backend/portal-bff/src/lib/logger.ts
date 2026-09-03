import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD portal_tutor_09 §10 saem por
 * aqui, no formato `{ metric, tenantId, value, unit }`.
 *
 * A redação é mais larga que a dos outros serviços por um motivo: **o identificador que
 * o tutor digita na porta é o dado mais sensível que este processo toca**. Ele é o par
 * "esta pessoa é cliente deste petshop", e um log com ele desfaz, num arquivo de texto,
 * a resposta uniforme que o módulo inteiro constrói.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'portal-bff',
  level: loadEnv().LOG_LEVEL,
  redact: ['*.identifier', '*.code', '*.phone', '*.email', '*.name', '*.maskedTarget'],
})

export type { BusinessMetric } from '@petshop/service-kit'
