import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC). O caso que pesa aqui é o tutor no Portal: ele lê o
 * **próprio** histórico, e uma tentativa de ler o de outro é exatamente o que este
 * registro existe para expor.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
