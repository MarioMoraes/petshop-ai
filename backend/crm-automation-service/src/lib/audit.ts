import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD relacionamento_crm_08 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  sensitiveKeys: ['variables', 'body', 'subject'],
})

export type { AuditEntry } from '@petshop/service-kit'
