/**
 * MOD-IDENT-04 — Papéis e matriz de permissões.
 *
 * Transcrição literal da "Matriz de Permissões Base" do PRD identidade_tenancy_01 §9.
 * Esta é a fonte única: o seed do banco (`packages/db/prisma/seed.ts`), a verificação
 * no gateway e os testes de matriz leem daqui.
 *
 * Convenção das chaves: `recurso:acao`. Sufixos com significado fixo:
 *   `_own`      → apenas os próprios registros do usuário/tutor
 *   `_assigned` → apenas os registros das corridas/tarefas atribuídas ao usuário
 *   `_summary`  → histórico de serviços e alertas, sem laudos nem prescrições (nota ² do PRD)
 *   `_alerts`   → temperamento e alergias, para segurança do profissional (nota ³ do PRD)
 */

export const PERMISSIONS = {
  // Tenant
  'tenant:read': 'Ver os dados do estabelecimento',
  'tenant:configure': 'Configurar o estabelecimento',
  'tenant:read_settings': 'Ler as configurações operacionais',

  // Equipe
  'team:read': 'Listar a equipe',
  'team:invite': 'Convidar membros para a equipe',
  'team:remove': 'Remover membros da equipe',

  // Tutores
  'tutor:read': 'Ver tutores',
  'tutor:read_assigned': 'Ver dados de contato dos tutores das corridas atribuídas',
  'tutor:read_own': 'Ver os próprios dados de tutor',
  'tutor:create': 'Cadastrar tutores',
  'tutor:update': 'Editar tutores',
  'tutor:update_own': 'Editar os próprios dados de tutor',
  'tutor:delete': 'Excluir tutores',

  // Pets
  'pet:read': 'Ver pets',
  'pet:read_assigned': 'Ver os pets das corridas atribuídas',
  'pet:read_own': 'Ver os próprios pets',
  'pet:create': 'Cadastrar pets',
  'pet:update': 'Editar pets',
  'pet:update_own': 'Editar os próprios pets',
  'pet:delete': 'Excluir pets',

  // Prontuário
  'record:read': 'Ler o prontuário completo',
  'record:read_summary': 'Ler o resumo do prontuário',
  'record:read_alerts': 'Ler alertas de temperamento e alergias',
  'record:write': 'Escrever no prontuário',
  'record:write_notes': 'Registrar observações no prontuário',

  // Financeiro
  'finance:read': 'Ler o financeiro dos tutores',
  'finance:read_own': 'Ler o próprio extrato',
  'finance:create': 'Lançar no financeiro',
  'finance:refund': 'Estornar lançamentos',

  // Agenda
  'schedule:read_all': 'Ver todas as agendas',
  'schedule:read_own': 'Ver a própria agenda',
  'schedule:write_all': 'Criar e editar qualquer agendamento',
  'schedule:write_own': 'Criar e editar os próprios agendamentos',
  'checkin:manage': 'Fazer check-in e check-out',

  // Operação e relacionamento
  'taxi:operate': 'Operar o Taxi Dog',
  'crm:manage': 'Gerenciar campanhas e CRM',
  'site:manage': 'Gerenciar o site do estabelecimento',
  'audit:read': 'Ler a trilha de auditoria',
} as const

export type PermissionKey = keyof typeof PERMISSIONS

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[]

export const ROLE_KEYS = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'RECEPTIONIST',
  'GROOMER',
  'BATHER',
  'VET',
  'DRIVER',
  'TUTOR',
] as const

export type RoleKey = (typeof ROLE_KEYS)[number]

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  TENANT_ADMIN: 'Administrador',
  RECEPTIONIST: 'Recepção',
  GROOMER: 'Tosador',
  BATHER: 'Banhista',
  VET: 'Veterinário',
  DRIVER: 'Motorista',
  TUTOR: 'Tutor',
}

/**
 * RN-05: o papel TUTOR nunca é membership de operação — tutores autenticam no Portal
 * e são resolvidos por `tutor_id`. SUPER_ADMIN é papel de plataforma, não de tenant.
 */
export const ASSIGNABLE_ROLE_KEYS = [
  'TENANT_ADMIN',
  'RECEPTIONIST',
  'GROOMER',
  'BATHER',
  'VET',
  'DRIVER',
] as const satisfies readonly RoleKey[]

export type AssignableRoleKey = (typeof ASSIGNABLE_ROLE_KEYS)[number]

/** RN-06: estes papéis geram/reativam um registro em `professionals` (MOD-AGENDA). */
export const PROFESSIONAL_ROLE_KEYS = [
  'GROOMER',
  'BATHER',
  'VET',
  'DRIVER',
] as const satisfies readonly RoleKey[]

const OPERATIONAL_BASE = ['tenant:read'] as const

export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  // Papel de plataforma: recebe tudo. O acesso a dados de negócio de um tenant ainda
  // exige `support_access_grant` ativo (RN-10, MOD-ADMIN).
  SUPER_ADMIN: PERMISSION_KEYS,

  TENANT_ADMIN: [
    'tenant:read',
    'tenant:configure',
    'tenant:read_settings',
    'team:read',
    'team:invite',
    'team:remove',
    'tutor:read',
    'tutor:create',
    'tutor:update',
    'tutor:delete',
    'pet:read',
    'pet:create',
    'pet:update',
    'pet:delete',
    'record:read',
    'record:read_summary',
    'record:read_alerts',
    'record:write',
    'record:write_notes',
    'finance:read',
    'finance:create',
    'finance:refund',
    'schedule:read_all',
    'schedule:read_own',
    'schedule:write_all',
    'schedule:write_own',
    'checkin:manage',
    'taxi:operate',
    'crm:manage',
    'site:manage',
    'audit:read',
  ],

  RECEPTIONIST: [
    ...OPERATIONAL_BASE,
    'tenant:read_settings',
    'team:read',
    'tutor:read',
    'tutor:create',
    'tutor:update',
    'pet:read',
    'pet:create',
    'pet:update',
    'record:read_summary',
    'record:read_alerts',
    'finance:read',
    'finance:create',
    'schedule:read_all',
    'schedule:read_own',
    'schedule:write_all',
    'schedule:write_own',
    'checkin:manage',
    'taxi:operate',
    'crm:manage',
  ],

  GROOMER: [
    ...OPERATIONAL_BASE,
    'tutor:read',
    'pet:read',
    'record:read_alerts',
    'record:write_notes',
    'schedule:read_own',
    'schedule:write_own',
    'checkin:manage',
  ],

  BATHER: [
    ...OPERATIONAL_BASE,
    'tutor:read',
    'pet:read',
    'record:read_alerts',
    'record:write_notes',
    'schedule:read_own',
    'schedule:write_own',
    'checkin:manage',
  ],

  VET: [
    ...OPERATIONAL_BASE,
    'tutor:read',
    'tutor:create',
    'tutor:update',
    'pet:read',
    'pet:create',
    'pet:update',
    'record:read',
    'record:read_summary',
    'record:read_alerts',
    'record:write',
    'record:write_notes',
    'schedule:read_own',
    'schedule:write_own',
    'checkin:manage',
  ],

  DRIVER: [...OPERATIONAL_BASE, 'tutor:read_assigned', 'pet:read_assigned', 'record:read_alerts', 'taxi:operate'],

  // Resolvido pelo portal-bff a partir de `tutor_id`, nunca de um membership (RN-05).
  TUTOR: [
    'tutor:read_own',
    'tutor:update_own',
    'pet:read_own',
    'pet:update_own',
    'record:read_summary',
    'finance:read_own',
    'schedule:read_own',
    'schedule:write_own',
  ],
}

export function permissionsForRole(role: RoleKey): readonly PermissionKey[] {
  return ROLE_PERMISSIONS[role]
}

export function roleHasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

export function isAssignableRole(role: string): role is AssignableRoleKey {
  return (ASSIGNABLE_ROLE_KEYS as readonly string[]).includes(role)
}

export function isProfessionalRole(role: RoleKey): boolean {
  return (PROFESSIONAL_ROLE_KEYS as readonly RoleKey[]).includes(role)
}
