import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD portal_tutor_09 §9). */

export const { sanitize, recordAudit } = createAudit({
  logger,
  // A trilha registra que o vínculo nasceu e para qual ficha — não o contato que o
  // provou. `audit_logs` é append-only e lido por mais gente que este módulo.
  sensitiveKeys: ['identifier', 'code', 'phone', 'email', 'maskedTarget'],
})

export type { AuditEntry } from '@petshop/service-kit'
