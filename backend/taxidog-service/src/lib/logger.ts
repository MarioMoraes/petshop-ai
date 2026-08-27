import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD taxi_dog_07 §10 saem por
 * aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'taxidog-service',
  level: loadEnv().LOG_LEVEL,
  // O endereço residencial e as instruções de acesso são o dado mais sensível que
  // este serviço manipula — e é o único que chega ao celular de alguém fora do
  // balcão. Nada disso pode vazar para o log (§9).
  redact: [
    '*.street',
    '*.number',
    '*.complement',
    '*.accessNotes',
    '*.notes',
    '*.fullName',
    '*.phone',
    '*.latitude',
    '*.longitude',
  ],
})

export type { BusinessMetric } from '@petshop/service-kit'
