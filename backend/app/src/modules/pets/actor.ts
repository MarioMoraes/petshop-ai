/**
 * Quem está agindo. Viaja junto de toda escrita porque a auditoria do §9 exige
 * `userId`, `ipAddress` e `userAgent` no registro — e passá-los explicitamente é o
 * que impede uma operação de ser gravada sem autor.
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
