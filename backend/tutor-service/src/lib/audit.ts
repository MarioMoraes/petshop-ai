import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/** Trilha de auditoria (PRD tutores_02 §9). */

export const { sanitize, recordAudit } = createAudit({ logger })

export type { AuditEntry } from '@petshop/service-kit'
