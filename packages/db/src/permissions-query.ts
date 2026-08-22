import { withTenant } from './client.js'

/**
 * Resolução da matriz de permissões efetiva de um usuário num tenant.
 *
 * Mora aqui, e não em um dos serviços, porque MOD-IDENT-04 exige a mesma verificação
 * em dois lugares — no gateway, que decide se a requisição segue, e no serviço, que
 * é a segunda linha de defesa. Duas implementações da mesma matriz divergiriam, e a
 * divergência apareceria como um furo de autorização.
 *
 * A consulta roda sob RLS, dentro de `withTenant`. Cada serviço cuida do próprio
 * cache — o TTL e a invalidação são decisões de quem chama.
 */

export interface ResolvedPermissions {
  roleKey: string
  permissions: string[]
  permVersion: number
}

export async function resolveEffectivePermissions(
  tenantId: string,
  userId: string,
): Promise<ResolvedPermissions | null> {
  return withTenant(tenantId, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      select: { roleKey: true, permVersion: true },
    })
    if (!membership) return null

    const [granted, overrides] = await Promise.all([
      tx.rolePermission.findMany({
        where: { roleKey: membership.roleKey },
        select: { permissionKey: true },
      }),
      tx.tenantRoleOverride.findMany({
        where: { tenantId, roleKey: membership.roleKey },
        select: { permissionKey: true, granted: true },
      }),
    ])

    const effective = new Set(granted.map((row) => row.permissionKey))
    // O override do tenant vem depois da matriz padrão: `granted: false` revoga,
    // `true` concede algo que o papel não tinha.
    for (const override of overrides) {
      if (override.granted) effective.add(override.permissionKey)
      else effective.delete(override.permissionKey)
    }

    return {
      roleKey: membership.roleKey,
      permissions: [...effective].sort(),
      permVersion: membership.permVersion,
    }
  })
}
