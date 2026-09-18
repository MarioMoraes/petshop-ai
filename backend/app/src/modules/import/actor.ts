/**
 * Quem está agindo. Viaja junto de toda escrita porque a auditoria exige `userId`,
 * `ipAddress` e `userAgent` no registro — e passá-los explicitamente é o que impede uma
 * operação de ser gravada sem autor.
 *
 * Declarado aqui, e não importado de um dos módulos de destino, porque o MOD-IMPORT
 * escreve nos três: herdar o tipo de um deles faria os outros dois parecerem menos
 * donos do que são. A forma é a mesma, de propósito — é o mesmo ator atravessando as
 * três portas.
 */
export interface ActorContext {
  tenantId: string
  actorUserId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}
