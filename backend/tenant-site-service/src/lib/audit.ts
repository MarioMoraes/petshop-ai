import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD site_tenant_10 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // A trilha registra que o lead mudou de status e quem o mudou — não o telefone de
  // quem o mandou. O `audit_log` é lido por mais gente que a fila de leads.
  sensitiveKeys: ['phone', 'email', 'message', 'ipAddress', 'userAgent'],
})

export type { AuditEntry } from '@petshop/service-kit'
