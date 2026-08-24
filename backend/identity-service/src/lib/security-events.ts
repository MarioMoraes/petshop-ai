import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC), gravados aqui porque MOD-IDENT-07 AC-02 e
 * MOD-IDENT-04 AC-02 exigem registro das tentativas negadas.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
