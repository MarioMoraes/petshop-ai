import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  DEFAULT_TERM_VERSION,
  TERM_KINDS,
  TERM_KIND_LABELS,
  type PublishTermVersionInput,
  type TermKind,
  type TermVersionView,
  type TermVersionsResponse,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { termVersionImmutable, termVersionUnknown } from '../tutors/errors.js'
import { cacheDelete, cacheGet, cacheSet } from '../../shared/redis.js'
import type { TermVersionMap } from '../tutors/mapper.js'
import type { ActorContext } from '../tutors/service.js'

/**
 * Termos versionados (MOD-DOC-06).
 *
 * O texto do termo passa a ser **dado**, e não constante. `CURRENT_TERMS_VERSION = '1.0'`
 * morava em `packages/shared-types` desde o MOD-TUTOR, com um `TODO(MOD-SEC)` pedindo
 * exatamente isto — e enquanto morou lá, o sistema registrou aceite, com IP e carimbo
 * de tempo, de um documento que não existia em lugar nenhum.
 *
 * Três regras moldam o módulo inteiro:
 *
 * 1. **Publicado é imutável.** Não há rascunho, não há PATCH e não há DELETE. Editar o
 *    texto que alguém aceitou é falsificar o contrato de todo mundo que aceitou.
 * 2. **A vigente é a mais recente.** Quem decide não é uma coluna `current` — é a data
 *    de publicação. Uma coluna diria "vigente" em duas linhas no dia em que alguém
 *    esquecesse de desmarcar a anterior.
 * 3. **Todo tenant nasce com a `1.0` da plataforma**, e o parque anterior foi preenchido
 *    pela migration com o mesmo número. É o que mantém válido, retroativamente, tudo o
 *    que já havia sido aceito.
 */

const versionsCacheKey = (tenantId: string) => `tutor:terms:${tenantId}`
const VERSIONS_TTL_SECONDS = 300

// ─── Leitura ─────────────────────────────────────────────────────────────────

interface TermVersionRow {
  id: string
  kind: TermKind
  version: string
  title: string
  body: string
  publishedAt: Date
  publishedBy: string | null
}

/**
 * Todas as versões, do mais recente para o mais antigo, com a contagem de aceites.
 *
 * A contagem não é enfeite: é ela que explica à tela por que uma versão não se edita.
 * `tutor_consents` guarda a versão como texto e não por FK — a linha é prova, e uma FK
 * a tornaria dependente de uma tabela que nasceu depois dela.
 */
export async function listTermVersions(tenantId: string): Promise<TermVersionsResponse> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.termVersion.findMany({
      orderBy: [{ kind: 'asc' }, { publishedAt: 'desc' }],
      take: 200,
    })

    const counts = await tx.tutorConsent.groupBy({
      by: ['channel', 'version'],
      where: { granted: true },
      _count: { _all: true },
    })

    const current = new Set(currentIdsOf(rows))

    return {
      versions: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        version: row.version,
        title: row.title,
        body: row.body,
        current: current.has(row.id),
        acceptances:
          counts.find((item) => item.channel === row.kind && item.version === row.version)?._count
            ._all ?? 0,
        publishedAt: row.publishedAt.toISOString(),
        publishedBy: row.publishedBy,
      })),
    } satisfies TermVersionsResponse
  })
}

/** O id da versão vigente de cada tipo, dada a lista ordenada por publicação. */
function currentIdsOf(rows: TermVersionRow[]): string[] {
  const vigente = new Map<TermKind, TermVersionRow>()
  for (const row of rows) {
    const atual = vigente.get(row.kind)
    if (!atual || row.publishedAt > atual.publishedAt) vigente.set(row.kind, row)
  }
  return [...vigente.values()].map((row) => row.id)
}

/**
 * A versão vigente de um tipo, com o texto — é o que a tela apresenta antes do aceite.
 *
 * Estourar 404 quando não há nenhuma é o resultado certo e não deveria acontecer: todo
 * tenant é semeado no provisionamento. Se acontecer, o que falta é a semente, e um
 * texto de reserva inventado aqui esconderia isso e produziria aceite de um documento
 * que ninguém publicou.
 */
export async function currentTermVersion(
  tx: TenantTransaction,
  kind: TermKind,
): Promise<TermVersionRow> {
  const row = await tx.termVersion.findFirst({
    where: { kind },
    orderBy: { publishedAt: 'desc' },
  })

  if (!row) {
    throw termVersionUnknown(
      `O estabelecimento ainda não publicou ${TERM_KIND_LABELS[kind].toLowerCase()}`,
    )
  }
  return row
}

/**
 * O número vigente de cada tipo, para a derivação de `PENDING_RENEWAL`.
 *
 * Cacheado porque toda leitura de ficha e de consentimento passa por aqui, e porque a
 * resposta só muda quando alguém publica — momento em que a chave é apagada. O padrão
 * da plataforma cobre o tipo sem linha nenhuma: sem ele, um tenant recém-criado veria
 * todo mundo em `PENDING_RENEWAL` até a primeira publicação.
 */
export async function currentTermVersions(tenantId: string): Promise<TermVersionMap> {
  const cached = await cacheGet<TermVersionMap>(versionsCacheKey(tenantId))
  if (cached) return cached

  const rows = await withTenant(tenantId, (tx) =>
    tx.termVersion.findMany({
      select: { kind: true, version: true, publishedAt: true },
      orderBy: { publishedAt: 'desc' },
    }),
  )

  const map = {
    TERMS: DEFAULT_TERM_VERSION,
    SERVICE_LIABILITY: DEFAULT_TERM_VERSION,
    IMAGE_USE: DEFAULT_TERM_VERSION,
  } satisfies TermVersionMap

  for (const kind of TERM_KINDS) {
    const row = rows.find((item) => item.kind === kind)
    if (row) map[kind] = row.version
  }

  await cacheSet(versionsCacheKey(tenantId), map, VERSIONS_TTL_SECONDS)
  return map
}

/**
 * AC-03 de MOD-DOC-06: a versão citada por um aceite precisa existir.
 *
 * Prova de aceite sem documento aceito é o defeito que este módulo veio corrigir; não se
 * recria ele por outro caminho. Vale para toda escrita em `tutor_consents`, inclusive a
 * do cadastro — o `1.0` semeado é o que faz o caminho comum passar.
 */
export async function assertTermVersionExists(
  tx: TenantTransaction,
  kind: TermKind,
  version: string,
): Promise<void> {
  const row = await tx.termVersion.findFirst({ where: { kind, version }, select: { id: true } })
  if (row) return

  throw termVersionUnknown(
    `A versão ${version} de ${TERM_KIND_LABELS[kind].toLowerCase()} não foi publicada`,
  )
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

/**
 * Publicar uma versão nova.
 *
 * Republicar um número existente devolve **409** `ERR_DOC_004`, e é essa a forma que o
 * AC-04 toma no código: não existe rota de edição para recusar, então o que se recusa é
 * a tentativa de dar dois textos ao mesmo número. A orientação vai na mensagem, porque
 * quem a lê é quem pode agir — publique a seguinte.
 */
export async function publishTermVersion(
  actor: ActorContext,
  input: PublishTermVersionInput,
): Promise<TermVersionView> {
  const row = await withTenant(
    actor.tenantId,
    async (tx) => {
      const existente = await tx.termVersion.findFirst({
        where: { kind: input.kind, version: input.version },
        select: { id: true },
      })

      if (existente) {
        throw termVersionImmutable(
          `A versão ${input.version} já foi publicada e não pode ser alterada. Publique uma versão nova.`,
        )
      }

      const created = await tx.termVersion.create({
        data: {
          tenantId: actor.tenantId,
          kind: input.kind,
          version: input.version,
          title: input.title,
          body: input.body,
          publishedBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'term_version.published',
        entity: 'term_version',
        entityId: created.id,
        after: { kind: created.kind, version: created.version, title: created.title },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return created
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  // A vigência mudou: quem tinha aceitado a anterior passa a `PENDING_RENEWAL`, e é
  // este `delete` que faz a mudança aparecer na próxima leitura de ficha.
  await cacheDelete(versionsCacheKey(actor.tenantId))

  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    title: row.title,
    body: row.body,
    current: true,
    acceptances: 0,
    publishedAt: row.publishedAt.toISOString(),
    publishedBy: row.publishedBy,
  }
}

/** O texto vigente, para a tela apresentar antes de colher o aceite. */
export async function currentTermForDisplay(
  tenantId: string,
  kind: TermKind,
): Promise<TermVersionView> {
  const { row, acceptances } = await withTenant(tenantId, async (tx) => {
    const found = await currentTermVersion(tx, kind)
    return {
      row: found,
      acceptances: await tx.tutorConsent.count({
        where: { channel: kind, version: found.version, granted: true },
      }),
    }
  })

  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    title: row.title,
    body: row.body,
    current: true,
    acceptances,
    publishedAt: row.publishedAt.toISOString(),
    publishedBy: row.publishedBy,
  }
}
