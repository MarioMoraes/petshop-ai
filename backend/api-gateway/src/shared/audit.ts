import { createAudit } from '@petshop/service-kit'
import { logger } from './logger.js'

/**
 * Trilha de auditoria (§9 dos PRDs).
 *
 * As chaves sensíveis são a **união** das listas dos módulos, pela mesma razão da
 * redação do log: o `audit_log` é lido por mais gente que qualquer módulo isolado.
 * Registra-se **que** algo mudou e quem mudou — não o telefone de quem mandou o lead
 * nem a rua e o número da casa do tutor.
 */

export const { sanitize, recordAudit } = createAudit({
  logger,
  sensitiveKeys: [
    // MOD-SITE
    'phone',
    'email',
    'message',
    'ipAddress',
    'userAgent',
    // MOD-TAXI
    'street',
    'number',
    'complement',
    'accessNotes',
    'notes',
    'latitude',
    'longitude',
    // MOD-CRM e MOD-NOTIF
    'variables',
    'body',
    'subject',
    'to',
    'address',
    // MOD-PET
    'microchip',
    'microchipEncrypted',
    'microchipHash',
    // MOD-PRONT — a trilha registra **que** a alergia mudou e quem mudou, nunca a
    // descrição da reação nem a posologia.
    'reaction',
    'reactionEncrypted',
    'instructions',
    'instructionsEncrypted',
  ],
})

export type { AuditEntry } from '@petshop/service-kit'
