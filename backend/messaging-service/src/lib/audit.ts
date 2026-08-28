import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD relacionamento_crm_08 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // A trilha registra **que** o texto mudou e quem mudou, não o texto. O `audit_logs`
  // é lido por mais gente que a mensagem, e o corpo tem dado do tutor dentro.
  sensitiveKeys: ['body', 'subject', 'to', 'address', 'phone', 'email', 'variables'],
})

export type { AuditEntry } from '@petshop/service-kit'
