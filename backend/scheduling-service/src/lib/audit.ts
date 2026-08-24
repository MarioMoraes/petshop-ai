import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD agenda_operacao_06 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // Campos livres do agendamento, que o §9 marca como risco de dado sensível
  // ("tocar o interfone 2, a sogra abre"; motivo de cancelamento que cita doença).
  sensitiveKeys: ['cancelReason', 'cancelReasonEncrypted'],
})

export type { AuditEntry } from '@petshop/service-kit'
