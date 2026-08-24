import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD pets_03 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // O microchip: identificador único rastreável do animal (PRD pets_03 §4). A trilha
  // registra que ele mudou e quem mudou, nunca o número — para lê-lo há o endpoint
  // dedicado, com auditoria própria.
  sensitiveKeys: ['microchip', 'microchipEncrypted', 'microchipHash'],
})

export type { AuditEntry } from '@petshop/service-kit'
