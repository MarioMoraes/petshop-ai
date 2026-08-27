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
  /** Só o peso, sem abrir o cadastro: é o que o banhista faz na balança (§9 de pets_03). */
  'pet:weigh': 'Registrar pesagem',
  /** Foto do banho pronto: o tosador manda a foto sem poder editar o cadastro (§9). */
  'pet:upload_photo': 'Enviar fotos do pet',
  /** Transferência de titularidade e reversão de óbito — as transições sem desfazer. */
  'pet:manage_lifecycle': 'Transferir titularidade e reverter óbito',
  'pet:manage_catalog': 'Gerenciar o catálogo de raças do estabelecimento',

  // Prontuário
  'record:read': 'Ler o prontuário completo',
  'record:read_summary': 'Ler o resumo do prontuário',
  'record:read_alerts': 'Ler alertas de temperamento e alergias',
  'record:write': 'Escrever no prontuário',
  'record:write_notes': 'Registrar observações no prontuário',
  /**
   * Criar alergia e alerta médico (MOD-PRONT-03/05). Separada de `record:write`
   * porque a recepção **registra** o que o tutor conta ("ele é alérgico a frango"),
   * mas quem desativa um alerta de segurança é o veterinário.
   */
  'record:write_alerts': 'Registrar alergias e alertas médicos',
  /**
   * Anular um atendimento (MOD-PRONT-09, AC-03). Separada de `record:write` porque
   * esta é de ADMIN **e** VET, e o §9 do prontuário dá a anulação só ao
   * administrador: anular estorna dinheiro no ledger, e quem responde por isso é
   * quem responde pelo caixa.
   */
  'record:void': 'Anular atendimento',

  // Financeiro
  'finance:read': 'Ler o financeiro dos tutores',
  'finance:read_own': 'Ler o próprio extrato',
  'finance:create': 'Lançar no financeiro',
  'finance:refund': 'Estornar lançamentos',
  /**
   * §9 do PRD financeiro: a matriz dá "lançar débito manual" à recepção (ela vende
   * ração no balcão) mas guarda "lançar crédito manual / desconto" para o
   * TENANT_ADMIN. Crédito sem contrapartida é dinheiro saindo do caixa, e quem
   * concede desconto assume o custo dele.
   */
  'finance:credit': 'Lançar crédito manual e conceder desconto',
  /**
   * `billing_settings` e o catálogo de pacotes. Mudar limite de crédito ou validade
   * de pacote é decisão de política comercial, não de balcão — mesmo corte que
   * separa `schedule:manage_catalog` de `schedule:write_all`.
   */
  'finance:configure': 'Configurar políticas financeiras e pacotes',

  // Agenda
  'schedule:read_all': 'Ver todas as agendas',
  'schedule:read_own': 'Ver a própria agenda',
  'schedule:write_all': 'Criar e editar qualquer agendamento',
  'schedule:write_own': 'Criar e editar os próprios agendamentos',
  'checkin:manage': 'Fazer check-in e check-out',
  /**
   * Serviços, preços, profissionais, jornadas e bloqueios (§9 do PRD da agenda:
   * "Gerir serviços e jornadas" é a única linha da matriz exclusiva do TENANT_ADMIN).
   * Separada de `schedule:write_all` porque a recepção agenda o dia inteiro, mas não
   * decide quanto custa um banho nem quem trabalha no sábado.
   */
  'schedule:manage_catalog': 'Gerenciar serviços, profissionais e jornadas',
  /**
   * AC-02 de MOD-AGENDA-10: liberar agendamento de tutor acima do limite de crédito.
   * A matriz do §9 dá isso **só** ao TENANT_ADMIN — a recepção convive com o cliente
   * e não deve carregar o peso de negar ou liberar crédito no balcão.
   */
  'schedule:override_credit': 'Liberar agendamento acima do limite de crédito',

  // Operação e relacionamento
  'taxi:operate': 'Operar o Taxi Dog',
  // MOD-TAXI §9: zonas, frota, configuração e preço manual. Separada de
  // `taxi:operate` porque quem dirige a van não redefine o preço da corrida.
  'taxi:configure': 'Configurar zonas, frota e preços do Taxi Dog',
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
    'pet:weigh',
    'pet:upload_photo',
    'pet:manage_lifecycle',
    'pet:manage_catalog',
    'record:read',
    'record:read_summary',
    'record:read_alerts',
    'record:write',
    'record:write_notes',
    'record:write_alerts',
    'record:void',
    'finance:read',
    'finance:create',
    'finance:refund',
    'finance:credit',
    'finance:configure',
    'schedule:read_all',
    'schedule:read_own',
    'schedule:write_all',
    'schedule:write_own',
    'schedule:manage_catalog',
    'schedule:override_credit',
    'checkin:manage',
    'taxi:operate',
    'taxi:configure',
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
    'pet:weigh',
    'pet:upload_photo',
    'record:read_summary',
    'record:read_alerts',
    'record:write_notes',
    'record:write_alerts',
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
    'pet:weigh',
    'pet:upload_photo',
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
    'pet:weigh',
    'pet:upload_photo',
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
    'pet:weigh',
    'pet:upload_photo',
    'record:read',
    'record:read_summary',
    'record:read_alerts',
    'record:write',
    'record:write_notes',
    'record:write_alerts',
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
    'pet:upload_photo',
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
