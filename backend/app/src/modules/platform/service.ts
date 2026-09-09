import { getPrisma } from '@petshop/db'
import { recordPlatformAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../shared/redis.js'
import { invalid, lastAdmin, notFound } from './errors.js'

/**
 * O papel de plataforma (MOD-ADMIN-01).
 *
 * `platform_admins` **não tem `tenant_id` e não está sob RLS**, então as consultas daqui
 * usam `getPrisma()` direto, fora de `withTenant` — a mesma forma que
 * `auth/portal-session.ts` usa para `users`, e pela mesma razão.
 *
 * A trilha destas operações vai com `tenantId: null`: é ação de plataforma, e atribuí-la
 * a um estabelecimento a esconderia justamente de quem precisa auditá-la.
 */

export interface PlatformAdminRef {
  id: string
  userId: string
  clerkUserId: string
  fullName: string
}

/**
 * Este usuário é da equipe da plataforma?
 *
 * Chamado uma vez por sessão sem Organization, e por isso vai a cache. **Cinco minutos é
 * aceitável aqui e não seria no grant**: conceder e revogar o papel é raro e a revogação
 * derruba a chave na hora; o grant de suporte existe para o caso em que o tenant quer que
 * pare *agora*, e por isso não entra em cache nenhum (RN-03).
 */
export async function resolvePlatformAdmin(clerkUserId: string): Promise<PlatformAdminRef | null> {
  const key = CACHE_KEYS.platformAdmin(clerkUserId)
  const cached = await cacheGet<PlatformAdminRef | { none: true }>(key)
  if (cached) return 'none' in cached ? null : cached

  const row = await getPrisma().platformAdmin.findFirst({
    where: { revokedAt: null, user: { clerkUserId } },
    select: { id: true, userId: true, user: { select: { clerkUserId: true, fullName: true } } },
  })

  const value: PlatformAdminRef | null = row
    ? {
        id: row.id,
        userId: row.userId,
        clerkUserId: row.user.clerkUserId,
        fullName: row.user.fullName,
      }
    : null

  /**
   * **O negativo vai a cache junto**, e é o caso que importa para o custo: toda sessão de
   * toda equipe de todo petshop que troque de contexto no Clerk passa por aqui e não é
   * da plataforma. Sem cachear o "não", a resposta mais comum seria a única a consultar o
   * banco sempre.
   */
  await cacheSet(key, value ?? { none: true }, CACHE_TTL_SECONDS.platformAdmin)
  return value
}

export interface PlatformAdminView {
  id: string
  userId: string
  fullName: string
  grantedAt: string
  grantedBy: string | null
}

export async function listPlatformAdmins(): Promise<PlatformAdminView[]> {
  const rows = await getPrisma().platformAdmin.findMany({
    where: { revokedAt: null },
    select: {
      id: true,
      userId: true,
      grantedAt: true,
      grantedBy: true,
      user: { select: { fullName: true } },
    },
    orderBy: { grantedAt: 'asc' },
  })

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    grantedAt: row.grantedAt.toISOString(),
    grantedBy: row.grantedBy,
  }))
}

/**
 * Concede o papel a quem **já tem espelho local** em `users` (AC-04).
 *
 * A exigência não é burocracia: o espelho nasce no primeiro acesso ao produto, e conceder
 * a quem nunca entrou criaria uma linha apontando para ninguém. A mensagem diz isso, em
 * vez de "usuário não encontrado" — que mandaria a pessoa procurar no lugar errado.
 */
export async function grantPlatformAdmin(
  actor: { userId: string; ipAddress?: string | undefined; userAgent?: string | undefined },
  emailHash: string,
): Promise<PlatformAdminView> {
  const user = await getPrisma().user.findUnique({
    where: { emailHash },
    select: { id: true, fullName: true, clerkUserId: true },
  })
  if (!user) {
    throw invalid('Esta pessoa ainda não acessou o produto — peça que ela entre uma vez primeiro')
  }

  const existing = await getPrisma().platformAdmin.findFirst({
    where: { userId: user.id, revokedAt: null },
    select: { id: true },
  })
  if (existing) {
    throw invalid('Esta pessoa já é administradora da plataforma')
  }

  const created = await getPrisma().platformAdmin.create({
    data: { userId: user.id, grantedBy: actor.userId },
    select: { id: true, grantedAt: true },
  })

  await recordPlatformAudit({
    action: 'platform.admin_granted',
    entity: 'platform_admin',
    entityId: created.id,
    actorUserId: actor.userId,
    after: { userId: user.id },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  await cacheDelete(CACHE_KEYS.platformAdmin(user.clerkUserId))

  return {
    id: created.id,
    userId: user.id,
    fullName: user.fullName,
    grantedAt: created.grantedAt.toISOString(),
    grantedBy: actor.userId,
  }
}

/**
 * Revoga o papel (AC-05).
 *
 * **A guarda do último administrador é a mesma do último `TENANT_ADMIN`** (RN-06 de
 * MOD-IDENT-04), e pela mesma razão: uma plataforma sem administrador não tem como voltar
 * a ter um — a concessão exige um administrador vivo, e a única saída seria `psql`.
 *
 * A contagem e a revogação ficam na mesma transação: duas revogações simultâneas veriam
 * ambas dois ativos e deixariam zero.
 */
export async function revokePlatformAdmin(
  actor: { userId: string; ipAddress?: string | undefined; userAgent?: string | undefined },
  id: string,
): Promise<void> {
  const clerkUserId = await getPrisma().$transaction(async (tx) => {
    const target = await tx.platformAdmin.findFirst({
      where: { id, revokedAt: null },
      select: { id: true, userId: true, user: { select: { clerkUserId: true } } },
    })
    if (!target) throw notFound('Administrador não encontrado')

    const ativos = await tx.platformAdmin.count({ where: { revokedAt: null } })
    if (ativos <= 1) throw lastAdmin()

    await tx.platformAdmin.update({
      where: { id: target.id },
      data: { revokedAt: new Date(), revokedBy: actor.userId },
    })

    return target.user.clerkUserId
  })

  await recordPlatformAudit({
    action: 'platform.admin_revoked',
    entity: 'platform_admin',
    entityId: id,
    actorUserId: actor.userId,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  await cacheDelete(CACHE_KEYS.platformAdmin(clerkUserId))
}

/**
 * A primeira linha, quando não há nenhuma (AC-06).
 *
 * Roda na subida, e só faz algo se `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` estiver definida **e**
 * a tabela estiver vazia. Sem a variável, a tabela nasce vazia e a superfície fica
 * inalcançável até alguém semear por `psql` — que é o estado correto, e não um erro: em
 * produção, semear pelo banco deixa rastro no acesso ao banco, que é auditado por fora.
 *
 * `grantedBy` fica nulo: não havia quem concedesse, e inventar um autor seria mentir na
 * primeira linha da trilha da plataforma.
 */
export async function bootstrapPlatformAdmin(emailHash: string | null): Promise<void> {
  if (!emailHash) return

  const ativos = await getPrisma().platformAdmin.count({ where: { revokedAt: null } })
  if (ativos > 0) return

  const user = await getPrisma().user.findUnique({
    where: { emailHash },
    select: { id: true, clerkUserId: true },
  })
  if (!user) {
    logger.warn(
      'PLATFORM_ADMIN_BOOTSTRAP_EMAIL aponta para quem ainda não acessou o produto — nenhum administrador de plataforma foi criado',
    )
    return
  }

  const created = await getPrisma().platformAdmin.create({
    data: { userId: user.id, grantedBy: null },
    select: { id: true },
  })

  await recordPlatformAudit({
    action: 'platform.admin_bootstrapped',
    entity: 'platform_admin',
    entityId: created.id,
    after: { userId: user.id },
  })

  await cacheDelete(CACHE_KEYS.platformAdmin(user.clerkUserId))
  logger.info({ userId: user.id }, 'primeiro administrador de plataforma criado pelo bootstrap')
}
