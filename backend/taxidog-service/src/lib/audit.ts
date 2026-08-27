import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD taxi_dog_07 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // A trilha registra **que** o endereço mudou e quem mudou, não a rua e o número:
  // o audit_log é lido por mais gente que a corrida.
  sensitiveKeys: ['street', 'number', 'complement', 'accessNotes', 'notes', 'latitude', 'longitude'],
})

export type { AuditEntry } from '@petshop/service-kit'
