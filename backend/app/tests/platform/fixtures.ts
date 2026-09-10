import { randomBytes } from 'node:crypto'
import {
  getApp,
  givenToken,
  ownerPrisma,
  resetDatabase as resetCore,
  seedMember,
  seedTenant,
  type Caller,
} from '../harness.js'

/**
 * Cenário do MOD-ADMIN — a superfície da equipe da plataforma.
 *
 * O núcleo (`../harness.js`) guarda o app, o banco e o verificador de token. O que fica
 * aqui é o que este módulo tem de próprio, e é pouco: **a sessão de plataforma não é um
 * `membership`**, então nenhum dos chamadores por papel do núcleo serve.
 *
 * Um login de plataforma é um usuário com espelho local e **token sem Organization** —
 * as duas coisas, porque token com Organization resolve como equipe de tenant e nunca
 * chega aqui (AC-03 de MOD-ADMIN-01).
 */

export * from '../harness.js'

const { hashEmail, encryptPlatform, getMaintenancePrisma } = await import('@petshop/db')

/**
 * Reseta o banco **e a tabela de plataforma**.
 *
 * `truncateBusinessTables` do núcleo não a alcança: ela não tem `tenant_id` e não é tabela
 * de negócio — mora ao lado de `users`, e é apagada aqui pela mesma razão que os testes
 * apagam os usuários entre si.
 */
export async function resetDatabase(): Promise<void> {
  await resetCore()
  await ownerPrisma.platformAdmin.deleteMany({})
  // A trilha da plataforma tem `tenant_id` nulo e escapa do truncate por tenant.
  await getMaintenancePrisma().auditLog.deleteMany({ where: { tenantId: null } })
  /**
   * A série e os alertas (MOD-ADMIN-05 e 06) também escapam: `truncateBusinessTables`
   * enumera tabelas de negócio, e estas duas são de plataforma — boa parte das linhas
   * nasce sem tenant nenhum.
   */
  await ownerPrisma.platformMetric.deleteMany({})
  await ownerPrisma.platformAlert.deleteMany({})
}

export interface PlatformUser {
  userId: string
  clerkUserId: string
  email: string
}

/** Alguém com conta no produto, e nada além disso. */
export async function givenUser(fullName = 'Equipe PetShop AI'): Promise<PlatformUser> {
  const suffix = randomBytes(6).toString('hex')
  const email = `${suffix}@petshopai.com`

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: encryptPlatform(email),
      emailHash: hashEmail(email),
      fullName,
    },
    select: { id: true, clerkUserId: true },
  })

  return { userId: user.id, clerkUserId: user.clerkUserId, email }
}

/** O mesmo, já com o papel de plataforma concedido. */
export async function givenPlatformAdmin(fullName?: string): Promise<PlatformUser> {
  const user = await givenUser(fullName)
  await ownerPrisma.platformAdmin.create({ data: { userId: user.userId } })
  return user
}

export interface PlatformCallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  user: PlatformUser
  payload?: unknown
  /**
   * A Organization no token.
   *
   * O padrão é **não ter nenhuma**, que é a sessão de plataforma. Quem exercita o AC-03 —
   * o administrador que também é dono de petshop — passa uma explicitamente.
   */
  clerkOrgId?: string | null
}

export async function callPlatform(options: PlatformCallOptions) {
  const app = await getApp()
  const token = givenToken({
    clerkUserId: options.user.clerkUserId,
    clerkOrgId: options.clerkOrgId ?? null,
  })

  return app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers: { authorization: `Bearer ${token}` },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/**
 * A trilha da plataforma — `tenant_id` nulo, invisível a todo tenant por RLS.
 *
 * O retorno é declarado, e não inferido do Prisma: sem a anotação o `tsc` recusa emitir
 * (TS2742, "cannot be named without a reference to node_modules"). Mesma armadilha do
 * `entriesOf` em `tests/ledger/fixtures.ts` — o `typecheck` do editor passa, e o erro
 * aparece no `build`.
 */
export interface PlatformAuditLine {
  id: string
  tenantId: string | null
  actorUserId: string | null
  action: string
  entity: string
  entityId: string | null
}

export async function platformAuditLines(action?: string): Promise<PlatformAuditLine[]> {
  return getMaintenancePrisma().auditLog.findMany({
    where: { tenantId: null, ...(action ? { action } : {}) },
    select: {
      id: true,
      tenantId: true,
      actorUserId: true,
      action: true,
      entity: true,
      entityId: true,
    },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * O header pelo qual a equipe da plataforma diz em que estabelecimento está agindo.
 *
 * Mesmo mecanismo do Portal, e pela mesma razão: quem chega não tem Organization no token.
 * Forjá-lo não leva a lugar nenhum — o contexto só existe se houver grant vivo.
 */
const ACTING_TENANT_HEADER = 'x-petshop-acting-tenant'

export interface TenantWithAdmin {
  tenantId: string
  clerkOrgId: string
  adminUserId: string
  /** O administrador do petshop, para chamar as rotas `/v1/support-access`. */
  admin: Caller
}

/** Um estabelecimento com um `TENANT_ADMIN` de verdade, que é quem autoriza o suporte. */
export async function givenTenantWithAdmin(slug: string): Promise<TenantWithAdmin> {
  const tenant = await seedTenant(slug)
  const membro = await seedMember(tenant.tenantId, 'TENANT_ADMIN')

  return {
    tenantId: tenant.tenantId,
    clerkOrgId: tenant.clerkOrgId,
    adminUserId: membro.userId,
    admin: { clerkUserId: membro.clerkUserId, clerkOrgId: tenant.clerkOrgId },
  }
}

/**
 * O suporte agindo **dentro** de um estabelecimento.
 *
 * Token sem Organization, como toda sessão de plataforma, mais o header que diz de qual
 * petshop se fala. A rota é a mesma que a equipe do petshop usa — é o ponto do desenho.
 */
export async function callSupport(options: {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  user: PlatformUser
  tenantId: string
  payload?: unknown
}) {
  const app = await getApp()
  const token = givenToken({ clerkUserId: options.user.clerkUserId, clerkOrgId: null })

  return app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers: {
      authorization: `Bearer ${token}`,
      [ACTING_TENANT_HEADER]: options.tenantId,
    },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/**
 * Números para o painel de uso (MOD-ADMIN-07).
 *
 * Cria só o que as seis contagens somam, e cada linha em duplicidade de estado: um tutor
 * ativo e um inativo, um documento emitido e um pendente. É o que prova que a contagem
 * conta o que diz contar — uma tabela com uma linha só passaria em qualquer filtro.
 *
 * Pet e atendimento ficam de fora de propósito: exigem espécie, porte e o catálogo do
 * MOD-PET inteiro para produzir um número que o mesmo `groupBy` já produz para tutores.
 */
export async function givenUsageData(tenantId: string): Promise<void> {
  const suffix = randomBytes(4).toString('hex')

  const ativo = await ownerPrisma.tutor.create({
    data: {
      tenantId,
      fullName: 'Cliente Ativo',
      phoneEncrypted: 'v1:x:x:x',
      phoneHash: `hash-a-${suffix}`,
      status: 'ACTIVE',
    },
    select: { id: true },
  })

  await ownerPrisma.tutor.create({
    data: {
      tenantId,
      fullName: 'Cliente Inativo',
      phoneEncrypted: 'v1:x:x:x',
      phoneHash: `hash-i-${suffix}`,
      status: 'INACTIVE',
    },
  })

  await ownerPrisma.document.createMany({
    data: [
      { tenantId, kind: 'RECEIPT', number: `R-${suffix}-1`, status: 'ISSUED' },
      { tenantId, kind: 'RECEIPT', number: `R-${suffix}-2`, status: 'PENDING' },
    ],
  })

  /**
   * O destinatário é obrigatório no banco (`messages_recipient_check`), e é por isso que a
   * mensagem se pendura no tutor ativo: o cenário não escolheu isso, o schema escolheu.
   */
  await ownerPrisma.message.createMany({
    data: [
      {
        tenantId,
        tutorId: ativo.id,
        channel: 'EMAIL',
        category: 'TRANSACTIONAL',
        templateKey: 'teste',
        toEncrypted: 'v1:x:x:x',
        toHash: `to-${suffix}-1`.padEnd(64, '0'),
        bodyEncrypted: 'v1:x:x:x',
        dedupeKey: `dedupe-${suffix}-1`,
        status: 'SENT',
        sentAt: new Date(),
      },
      {
        tenantId,
        tutorId: ativo.id,
        channel: 'EMAIL',
        category: 'TRANSACTIONAL',
        templateKey: 'teste',
        toEncrypted: 'v1:x:x:x',
        toHash: `to-${suffix}-2`.padEnd(64, '0'),
        bodyEncrypted: 'v1:x:x:x',
        dedupeKey: `dedupe-${suffix}-2`,
        status: 'QUEUED',
      },
    ],
  })
}
