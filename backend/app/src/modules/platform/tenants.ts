import { Prisma, getMaintenancePrisma } from '@petshop/db'
import type {
  PlatformTenant,
  PlatformTenantPage,
  TenantListQuery,
  TenantUsage,
} from '@petshop/shared-types'
import { notFound } from './errors.js'

/**
 * O painel de estabelecimentos e o uso de cada um (MOD-ADMIN-03 e 07).
 *
 * **Este arquivo lê o banco inteiro e não devolve um único dado pessoal.** É a fronteira
 * do módulo, e ela está no `SELECT`: contagem de tutores, de pets, de atendimentos — nunca
 * o nome de um deles. A contagem não vira identificação nem quando o denominador é um
 * (RN-11), e é por isso que o painel de uso responde **sem grant**: número de clientes é
 * informação comercial sobre o estabelecimento, não sobre os clientes dele.
 *
 * As consultas passam por `getMaintenancePrisma()` porque são cross-tenant por definição —
 * o mesmo caminho que as varreduras noturnas do MOD-LEDGER e do MOD-AGENDA usam, e pela
 * mesma razão: não há um tenant a colocar no contexto quando a pergunta é sobre todos.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface TenantRow {
  id: string
  slug: string
  name: string
  status: string
  plan: string
  trial_ends_at: Date | null
  created_at: Date
  onboarding_completed_at: Date | null
  provisioning_attempts: number
  provisioning_last_error: string | null
}

interface CountRow {
  total: bigint
}

/**
 * A lista, com o provisionamento travado no topo (AC-02).
 *
 * A ordenação é SQL cru por um motivo: `ORDER BY (status = 'PROVISIONING_FAILED') DESC`
 * não tem equivalente no `orderBy` do Prisma, e ordenar pelo enum colocaria o estado que
 * pede socorro no fim da lista — é a ordem de declaração do tipo, e ela não tem nada a ver
 * com urgência. Ordenar em memória seria pior ainda: acertaria a página e erraria o
 * conjunto, que é o defeito clássico de paginar o que já foi cortado.
 */
export async function listTenants(query: TenantListQuery): Promise<PlatformTenantPage> {
  const where = buildWhere(query)
  const prisma = getMaintenancePrisma()

  const [counted, rows] = await Promise.all([
    prisma.$queryRaw<CountRow[]>(
      Prisma.sql`SELECT count(*)::bigint AS total FROM "tenants" t ${where}`,
    ),
    prisma.$queryRaw<TenantRow[]>(Prisma.sql`
      SELECT t."id", t."slug", t."name", t."status"::text, t."plan"::text,
             t."trial_ends_at", t."created_at", t."onboarding_completed_at",
             t."provisioning_attempts", t."provisioning_last_error"
        FROM "tenants" t
        ${where}
       ORDER BY (t."status" = 'PROVISIONING_FAILED') DESC, t."created_at" DESC
       LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `),
  ])

  const ids = rows.map((row) => row.id)
  const [usage, activity] = await Promise.all([usageByTenant(ids), lastActivityByTenant(ids)])

  return {
    data: rows.map((row) => toTenant(row, usage.get(row.id) ?? emptyUsage(), activity.get(row.id))),
    total: Number(counted[0]?.total ?? 0),
    page: query.page,
    limit: query.limit,
  }
}

/**
 * As contagens de um estabelecimento (MOD-ADMIN-07).
 *
 * Mesma função da lista, com um id só: manter dois caminhos para o mesmo número é como o
 * painel e o detalhe passam a discordar sem que ninguém saiba qual está certo.
 */
export async function tenantUsage(tenantId: string): Promise<TenantUsage> {
  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { id: true },
  })
  if (!tenant) throw notFound('Estabelecimento não encontrado')

  const usage = await usageByTenant([tenantId])
  return usage.get(tenantId) ?? emptyUsage()
}

function buildWhere(query: TenantListQuery): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`t."deleted_at" IS NULL`]

  if (query.status) conditions.push(Prisma.sql`t."status" = ${query.status}::"TenantStatus"`)
  if (query.plan) conditions.push(Prisma.sql`t."plan" = ${query.plan}::"Plan"`)
  if (query.q) {
    // Nome ou slug, sem acento e sem caixa. O `q` nunca alcança dado de tutor: procurar
    // uma pessoa pelo painel da plataforma é exatamente o que o grant existe para mediar.
    const alvo = `%${query.q.toLowerCase()}%`
    conditions.push(Prisma.sql`(lower(t."name") LIKE ${alvo} OR lower(t."slug") LIKE ${alvo})`)
  }

  return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
}

function toTenant(
  row: TenantRow,
  usage: TenantUsage,
  lastActivityAt: Date | null | undefined,
): PlatformTenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as PlatformTenant['status'],
    plan: row.plan as PlatformTenant['plan'],
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    onboardingCompletedAt: row.onboarding_completed_at?.toISOString() ?? null,
    lastActivityAt: lastActivityAt?.toISOString() ?? null,
    /**
     * Só quem falhou o provisionamento carrega o bloco.
     *
     * Num tenant que subiu bem, `provisioning_attempts` é ruído — todos têm uma tentativa
     * e nenhum erro. O campo existir apenas onde significa algo é o que faz a coluna do
     * painel ser lida.
     */
    provisioning:
      row.status === 'PROVISIONING_FAILED'
        ? { attempts: row.provisioning_attempts, lastError: row.provisioning_last_error }
        : null,
    usage,
  }
}

function emptyUsage(): TenantUsage {
  return {
    tutors: 0,
    pets: 0,
    attendances30d: 0,
    messagesThisMonth: 0,
    documents: 0,
    photoBytes: 0,
  }
}

/**
 * As seis contagens, em seis consultas — não em seis por tenant.
 *
 * Um `count` por estabelecimento por métrica daria 120 idas ao banco numa página de vinte,
 * e o painel que existe para observar a plataforma seria a consulta mais cara dela. Cada
 * `groupBy` aqui varre uma tabela filtrando pelos ids da página e devolve todas as linhas
 * de uma vez.
 */
async function usageByTenant(tenantIds: string[]): Promise<Map<string, TenantUsage>> {
  const resultado = new Map<string, TenantUsage>()
  if (tenantIds.length === 0) return resultado

  const prisma = getMaintenancePrisma()
  const desde30 = new Date(Date.now() - 30 * DAY_MS)
  const inicioDoMes = startOfMonth(new Date())
  const scope = { tenantId: { in: tenantIds } }

  const [tutors, pets, attendances, messages, documents, photos] = await Promise.all([
    prisma.tutor.groupBy({ by: ['tenantId'], where: { ...scope, status: 'ACTIVE' }, _count: { _all: true } }),
    prisma.pet.groupBy({ by: ['tenantId'], where: { ...scope, status: 'ACTIVE' }, _count: { _all: true } }),
    prisma.attendance.groupBy({
      by: ['tenantId'],
      where: { ...scope, startedAt: { gte: desde30 }, status: { not: 'VOIDED' } },
      _count: { _all: true },
    }),
    /**
     * Enviada é a que **saiu**, e a marca disso é `sent_at` — não o status.
     *
     * Contar por status obrigaria a listar `SENT`, `DELIVERED` e `READ` e a corrigir a
     * lista a cada estado novo do provedor; e `FAILED` depois de uma entrega parcial
     * ficaria de fora enquanto o disparo já tinha acontecido.
     */
    prisma.message.groupBy({
      by: ['tenantId'],
      where: { ...scope, sentAt: { gte: inicioDoMes } },
      _count: { _all: true },
    }),
    prisma.document.groupBy({
      by: ['tenantId'],
      where: { ...scope, status: 'ISSUED' },
      _count: { _all: true },
    }),
    prisma.petPhoto.groupBy({
      by: ['tenantId'],
      where: { ...scope, deletedAt: null },
      _sum: { sizeBytes: true },
    }),
  ])

  for (const tenantId of tenantIds) resultado.set(tenantId, emptyUsage())

  const set = (tenantId: string, patch: Partial<TenantUsage>): void => {
    const atual = resultado.get(tenantId)
    if (atual) Object.assign(atual, patch)
  }

  for (const row of tutors) set(row.tenantId, { tutors: row._count._all })
  for (const row of pets) set(row.tenantId, { pets: row._count._all })
  for (const row of attendances) set(row.tenantId, { attendances30d: row._count._all })
  for (const row of messages) set(row.tenantId, { messagesThisMonth: row._count._all })
  for (const row of documents) set(row.tenantId, { documents: row._count._all })
  for (const row of photos) set(row.tenantId, { photoBytes: row._sum.sizeBytes ?? 0 })

  return resultado
}

/**
 * A última linha de trilha de cada estabelecimento.
 *
 * É proxy de atividade, e assumido como tal: `audit_logs` registra escrita, então um
 * tenant que passou a semana consultando aparece parado. O sinal exato exigiria carimbar
 * toda requisição — uma escrita por leitura, cara justamente no caminho mais quente do
 * produto —, e o que a coluna precisa responder é "este petshop ainda usa o sistema?",
 * que a última escrita responde bem.
 */
async function lastActivityByTenant(tenantIds: string[]): Promise<Map<string, Date | null>> {
  const resultado = new Map<string, Date | null>()
  if (tenantIds.length === 0) return resultado

  const rows = await getMaintenancePrisma().auditLog.groupBy({
    by: ['tenantId'],
    where: { tenantId: { in: tenantIds } },
    _max: { createdAt: true },
  })

  for (const row of rows) {
    if (row.tenantId) resultado.set(row.tenantId, row._max.createdAt)
  }
  return resultado
}

/** O primeiro instante do mês civil corrente, em UTC. */
function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}
