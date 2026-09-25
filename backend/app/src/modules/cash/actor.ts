/**
 * Quem está agindo. Viaja junto de toda escrita porque a trilha exige autor, IP e
 * user-agent, e passá-los explicitamente impede um movimento de ser gravado sem dono.
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
