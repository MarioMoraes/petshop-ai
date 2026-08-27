import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC). Aqui pesa o caso do motorista: `taxi:operate` no
 * papel DRIVER vale só para as **próprias** corridas (RN-19), e a tentativa de mexer
 * na corrida de um colega é exatamente o que este registro existe para expor.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
