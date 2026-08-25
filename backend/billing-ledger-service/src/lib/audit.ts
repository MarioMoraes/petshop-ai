import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/**
 * Trilha de auditoria (PRD financeiro_tutor_05 §9).
 *
 * Este é o módulo em que a trilha mais importa: `ledger.allocation_manual` —
 * quitação fora do FIFO — é o vetor clássico de desvio no balcão, e `ledger.
 * discount_granted` responde "quem deu esse desconto" meses depois.
 */

export const { sanitize, recordAudit } = createAudit({
  logger,
  sensitiveKeys: [
    'internalNotes',
    'internalNotesEncrypted',
    'notes',
    'notesEncrypted',
    'proofUrl',
    'proofUrlEncrypted',
    'suspensionReason',
    'suspensionReasonEncrypted',
  ],
})

export type { AuditEntry } from '@petshop/service-kit'
