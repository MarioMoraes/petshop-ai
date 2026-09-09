import type { RoleKey } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'

/**
 * A carência de MFA (MOD-SEC-03).
 *
 * **O prazo é do papel, não da pessoa.** É escrito na coluna `mfa_grace_until` do
 * membership toda vez que ele passa a ser administrativo — na criação do tenant, no
 * aceite de um convite de administrador, e na promoção. A alternativa era derivar o
 * prazo de uma data de corte no ambiente somada a `joined_at`, e ela erra exatamente no
 * caso que importa: uma recepcionista promovida a administradora em março tem
 * `joined_at` de janeiro, e seria barrada no instante em que ganhou o papel.
 *
 * Papel não administrativo devolve `null`, e é assim que a coluna é **limpa** no
 * rebaixamento: quem deixa de ser administrador não guarda prazo, e se um dia voltar,
 * ganha carência nova.
 */
export function mfaGraceFor(roleKey: string, now = new Date()): Date | null {
  if (!requiresMfa(roleKey)) return null
  return new Date(now.getTime() + loadEnv().MFA_GRACE_DAYS * 24 * 60 * 60 * 1000)
}

/** RN-01 — só o administrador do estabelecimento. */
export function requiresMfa(roleKey: string): boolean {
  return roleKey === ('TENANT_ADMIN' satisfies RoleKey)
}
