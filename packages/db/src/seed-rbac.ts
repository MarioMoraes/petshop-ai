import {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type PermissionKey,
  type RoleKey,
} from '@petshop/shared-types'
import type { PrismaClient } from '#prisma-client'

/**
 * Seed dos dados globais de RBAC (MOD-IDENT-04).
 *
 * `roles`, `permissions` e `role_permissions` não têm `tenant_id` nem RLS — são a
 * matriz padrão da plataforma. O ajuste por tenant vive em `tenant_role_overrides`,
 * que não é semeado.
 *
 * Exportado como função para que a suíte de testes chame direto, sem subprocesso.
 */

export interface SeedCounts {
  permissions: number
  roles: number
  rolePermissions: number
}

export async function seedRbac(prisma: PrismaClient): Promise<SeedCounts> {
  const permissionEntries = Object.entries(PERMISSIONS) as [PermissionKey, string][]

  await prisma.$transaction([
    ...permissionEntries.map(([key, description]) =>
      prisma.permission.upsert({
        where: { key },
        create: { key, description },
        update: { description },
      }),
    ),
    ...ROLE_KEYS.map((key: RoleKey) =>
      prisma.role.upsert({
        where: { key },
        create: { key, label: ROLE_LABELS[key], isSystem: true },
        update: { label: ROLE_LABELS[key], isSystem: true },
      }),
    ),
  ])

  // A matriz é reescrita por inteiro: retirar uma permissão do `shared-types`
  // também a retira do banco, em vez de deixar resíduo concedido.
  const pairs = ROLE_KEYS.flatMap((roleKey) =>
    ROLE_PERMISSIONS[roleKey].map((permissionKey) => ({ roleKey, permissionKey })),
  )

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({}),
    prisma.rolePermission.createMany({ data: pairs, skipDuplicates: true }),
  ])

  return {
    permissions: permissionEntries.length,
    roles: ROLE_KEYS.length,
    rolePermissions: pairs.length,
  }
}
