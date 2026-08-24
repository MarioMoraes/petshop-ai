import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC). O medical-record-service registra as negações de
 * permissão do PRD prontuario_04 §9 e as tentativas de alcançar prontuário de outro
 * tenant.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
