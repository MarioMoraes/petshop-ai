import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas do PRD site_tenant_10 §10 saem por
 * aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'tenant-site-service',
  level: loadEnv().LOG_LEVEL,
  // O endereço do estabelecimento é público e não se redige. O que **não** pode
  // vazar para o log é o lead: nome, telefone e e-mail de alguém que só perguntou o
  // preço do banho, e que não tem relação nenhuma com o petshop ainda.
  redact: ['*.phone', '*.email', '*.name', '*.message', '*.ipAddress', '*.userAgent'],
})

export type { BusinessMetric } from '@petshop/service-kit'
