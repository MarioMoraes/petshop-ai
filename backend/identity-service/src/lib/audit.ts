import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/**
 * Trilha de auditoria (MOD-IDENT-09). A lista de ações que **devem** gerar registro
 * está no PRD §9.
 */

export const { sanitize, recordAudit } = createAudit({ logger })

export type { AuditEntry } from '@petshop/service-kit'
