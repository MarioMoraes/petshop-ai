import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC). O scheduling-service registra as negações de
 * permissão do PRD agenda_operacao_06 §9 e as tentativas de alcançar agenda de outro
 * tenant.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
