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
    // MOD-AGENDA — o motivo do cancelamento é campo livre, e o §9 o classifica como
    // risco: "não vou porque o cachorro está com um caroço" é dado de saúde escrito
    // no balcão.
    'cancelReason',
    'cancelReasonEncrypted',
    // MOD-LEDGER — o módulo em que a trilha mais importa, e onde o campo livre é o
    // que menos deve entrar nela: `internal_notes` carrega juízo de valor sobre o
    // titular, e `proof_url` pode exibir dado bancário de terceiro.
    'internalNotes',
    'internalNotesEncrypted',
    'notesEncrypted',
    'proofUrl',
    'proofUrlEncrypted',
    'suspensionReason',
    'suspensionReasonEncrypted',
    // MOD-PORTAL — a trilha registra que o vínculo nasceu e para qual ficha, nunca o
    // contato que o provou nem o código que chegou nele.
    'identifier',
    'code',
    'maskedTarget',
  ],
})

export type { AuditEntry } from '@petshop/service-kit'
