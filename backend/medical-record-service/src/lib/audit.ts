import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD prontuario_04 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // Campos clínicos livres: a trilha registra **que** a alergia mudou e quem mudou,
  // não a descrição da reação.
  sensitiveKeys: ['reaction', 'reactionEncrypted', 'instructions', 'instructionsEncrypted'],
})

export type { AuditEntry } from '@petshop/service-kit'
