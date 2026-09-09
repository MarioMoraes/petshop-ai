/**
 * Quem está agindo. Viaja junto de toda escrita porque a auditoria do §9 exige
 * `userId`, `ipAddress` e `userAgent` no registro — e passá-los explicitamente é o
 * que impede um lançamento de ser gravado sem autor.
 *
 * Neste módulo isso não é formalidade: `payments.received_by` responde "quem pegou o
 * dinheiro no balcão", e é a coluna para a qual se olha quando o caixa não fecha.
 */
export interface ActorContext {
  tenantId: string
  actorUserId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

/** Opções de `withTenant` derivadas do ator, para o `updated_by` dos triggers. */
export function tenantOptions(actor: ActorContext): { userId?: string } {
  return actor.actorUserId ? { userId: actor.actorUserId } : {}
}
