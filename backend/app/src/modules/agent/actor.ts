/**
 * Quem está agindo. Viaja junto de toda escrita porque a auditoria do §9 exige
 * `userId`, `ipAddress` e `userAgent` no registro.
 */
export interface ActorContext {
  tenantId: string
  actorUserId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export function tenantOptions(actor: ActorContext): { userId?: string } {
  return actor.actorUserId ? { userId: actor.actorUserId } : {}
}
