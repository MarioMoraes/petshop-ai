import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC).
 *
 * O Portal é a segunda superfície do sistema aberta a quem não é funcionário, e a
 * primeira em que a pessoa do outro lado se autentica. Tentativa de sequestro de ficha
 * (AC-04 de MOD-PORTAL-01) e força bruta no código (AC-05) viram registro — não porque
 * cada uma importe isolada, mas porque a série delas é o que denuncia um ataque.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
