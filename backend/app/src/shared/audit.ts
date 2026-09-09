import { createAudit, type AuditEntry } from '@petshop/service-kit'
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

/**
 * A trilha de uma ação **da plataforma**, sem tenant a que atribuí-la (MOD-ADMIN-01).
 *
 * `recordAudit` recebe a transação em curso e escreve como `app_user`; a política de
 * `audit_logs` é `tenant_id = current_tenant_id()`, que é falso para `NULL` — a linha
 * seria recusada. É exatamente a mesma situação que `recordSecurityEvent` já resolve para
 * o evento da instalação, e a saída é a mesma: `app_maintenance`, que tem `BYPASSRLS`.
 *
 * **Transação própria, e não a da requisição.** Conceder o papel de plataforma e registrar
 * que ele foi concedido são duas coisas que não podem cair juntas: se a segunda falhar, a
 * primeira já aconteceu e precisa ser conhecida. É a mesma decisão do evento de segurança,
 * pelo motivo oposto — lá a operação vai dar rollback e o registro precisa sobreviver;
 * aqui a operação já foi confirmada e o registro não pode desfazê-la.
 *
 * `tenantId` fica `null` de propósito: atribuir a ação a um estabelecimento a esconderia,
 * por RLS, de quem precisa auditá-la — e a mostraria a quem não tem nada com ela.
 */
export async function recordPlatformAudit(entry: AuditEntry): Promise<void> {
  const { getMaintenancePrisma } = await import('@petshop/db')

  try {
    await getMaintenancePrisma().auditLog.create({
      data: {
        tenantId: null,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: entry.before === undefined ? undefined : (sanitize(entry.before) as object),
        after: entry.after === undefined ? undefined : (sanitize(entry.after) as object),
        outcome: entry.outcome ?? 'ALLOWED',
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    })
  } catch (error) {
    // Nunca deixar a falha do registro mascarar a operação que ele descreve.
    logger.error({ err: error, action: entry.action }, 'falha ao registrar trilha de plataforma')
  }
}
