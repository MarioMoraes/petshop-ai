import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC). Aqui se registram as negações da matriz do §9 — em
 * especial as tentativas de estorno pela recepção (RN-25: o balcão registra, o gestor
 * corrige) e de leitura de extrato alheio.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
