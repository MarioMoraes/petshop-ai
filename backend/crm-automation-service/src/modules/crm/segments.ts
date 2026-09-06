import type { TenantTransaction } from '@petshop/db'
import type { CampaignSegment, CampaignSkipReason } from '@petshop/shared-types'

/**
 * Quem o segmento alcança, e o que impede cada um de receber.
 *
 * O arquivo tem duas metades e a divisão entre elas é a regra que a prévia depende:
 *
 * - **O filtro** decide quem *entra na mira*. É o que o admin escolheu: tags, tempo sem
 *   aparecer, espécie, porte.
 * - **A classificação** decide quem *recebe*. É o que o sistema sabe e o admin não:
 *   consentimento, dívida, óbito, teto semanal, carência.
 *
 * Quem é barrado pela segunda metade **continua sendo um alvo** — vira `SKIPPED` com o
 * motivo. Se fosse filtrado junto com a primeira, a prévia diria "300 destinatários" sem
 * nunca explicar os 40 que sumiram, e é exatamente essa explicação que o AC-01 de
 * MOD-CRM-12 pede.
 *
 * A consequência prática, que vale ter em mente ao mexer: **nenhuma condição de
 * classificação pode virar cláusula SQL**. A tentação é grande — `AND balance_cents >= 0`
 * é uma linha — e o custo é a prévia mentir.
 */

const MAX_CANDIDATES = 5_000

/** Os estados de mensagem que contam para o teto semanal — os mesmos de `frequency.ts`. */
const COUNTED_STATUSES = ['QUEUED', 'SCHEDULED', 'SENDING', 'SENT', 'DELIVERED', 'READ'] as const

export interface Candidate {
  tutorId: string
  name: string
  /** `null` quando nada impede: esta pessoa recebe. */
  skipReason: CampaignSkipReason | null
}

export interface ResolveOptions {
  /** A campanha cuja carência conta. Ausente = sem carência (campanha manual). */
  campaignId?: string
  cooldownDays?: number
  now: Date
}

export async function resolveSegment(
  tx: TenantTransaction,
  segment: CampaignSegment,
  options: ResolveOptions,
): Promise<Candidate[]> {
  const now = options.now

  const tutors = await tx.tutor.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      ...(segment.tagKeys?.length
        ? { tagAssignments: { some: { tag: { key: { in: segment.tagKeys } } } } }
        : {}),
      // "Sem atendimento há N dias" inclui **quem nunca foi atendido**. Um cadastro de
      // seis meses que nunca marcou nada é o inativo mais inativo que existe, e deixá-lo
      // de fora por `last_attendance_at` ser nulo esconderia justamente quem a campanha
      // de reativação deveria alcançar primeiro.
      ...(segment.inactiveDaysMin !== undefined
        ? {
            OR: [
              { lastAttendanceAt: null },
              { lastAttendanceAt: { lte: daysAgo(now, segment.inactiveDaysMin) } },
            ],
          }
        : {}),
      ...(segment.activeDaysMax !== undefined
        ? { lastAttendanceAt: { gte: daysAgo(now, segment.activeDaysMax) } }
        : {}),
      ...(segment.speciesIds?.length || segment.sizeIds?.length
        ? {
            petTutors: {
              some: {
                unlinkedAt: null,
                pet: {
                  status: 'ACTIVE',
                  deletedAt: null,
                  ...(segment.speciesIds?.length ? { speciesId: { in: segment.speciesIds } } : {}),
                  ...(segment.sizeIds?.length ? { sizeId: { in: segment.sizeIds } } : {}),
                },
              },
            },
          }
        : {}),
    },
    select: { id: true, fullName: true, balanceCents: true },
    orderBy: { fullName: 'asc' },
    take: MAX_CANDIDATES,
  })

  if (tutors.length === 0) return []

  const ids = tutors.map((tutor) => tutor.id)

  // Quatro consultas em lote, e não quatro por tutor. Uma campanha de mil pessoas com
  // classificação em N+1 seriam quatro mil idas ao banco por prévia — e a prévia é
  // clicada várias vezes antes de alguém disparar.
  const [withPets, consenting, recentMarketing, cooledDown] = await Promise.all([
    tutorsWithLivePets(tx, ids),
    tutorsConsentingToMarketing(tx, ids),
    tutorsAtWeeklyCap(tx, ids, now),
    options.campaignId && options.cooldownDays
      ? tutorsInCooldown(tx, ids, options.campaignId, daysAgo(now, options.cooldownDays))
      : new Set<string>(),
  ])

  return tutors.map((tutor) => ({
    tutorId: tutor.id,
    name: tutor.fullName,
    skipReason: classify(tutor, segment, {
      hasLivePet: withPets.has(tutor.id),
      hasConsent: consenting.has(tutor.id),
      atWeeklyCap: recentMarketing.has(tutor.id),
      inCooldown: cooledDown.has(tutor.id),
    }),
  }))
}

/**
 * A ordem das perguntas é a ordem da resposta.
 *
 * Um tutor pode ser barrado por três motivos ao mesmo tempo, e o que a tela mostra é o
 * primeiro. A sequência vai do que o petshop **decidiu** para o que o tutor **decidiu**:
 * a carência e a dívida são política do estabelecimento, e saber que a pessoa foi pulada
 * por isso é acionável; "sem consentimento" no lugar disso mandaria a recepção
 * incomodá-la para pedir um opt-in que não era o problema.
 */
function classify(
  tutor: { balanceCents: number },
  segment: CampaignSegment,
  flags: {
    hasLivePet: boolean
    hasConsent: boolean
    atWeeklyCap: boolean
    inCooldown: boolean
  },
): CampaignSkipReason | null {
  if (flags.inCooldown) return 'ALREADY_TARGETED'
  // Saldo negativo é dívida (RN-02 do MOD-LEDGER).
  if (segment.excludeDebtors && tutor.balanceCents < 0) return 'HAS_DEBT'
  if (segment.requiresActivePet && !flags.hasLivePet) return 'PET_DECEASED'
  if (!flags.hasConsent) return 'NO_CONSENT'
  if (flags.atWeeklyCap) return 'WEEKLY_CAP'
  return null
}

/**
 * **`NO_CHANNEL` e `SUPPRESSED` não são decididos aqui**, e é intencional.
 *
 * O primeiro porque `tutors.phone_encrypted` é NOT NULL: um tutor sem telefone tem o
 * campo **vazio**, não ausente, e descobrir isso exigiria abrir a DEK do tenant e
 * decifrar a coluna de cada candidato — trabalho de criptografia numa prévia que a
 * pessoa clica cinco vezes seguidas. O segundo porque a supressão é por hash do endereço,
 * que só se calcula depois de decifrar.
 *
 * As duas voltam do motor no `blockReason` e viram `SKIPPED` com o mesmo nome (ver
 * `mapBlockReason` em `campaigns.ts`). A prévia erra por otimismo nesses dois casos — ela
 * conta como elegível quem o motor vai bloquear —, e essa é a queda certa: uma prévia
 * pessimista esconderia gente que na verdade recebe.
 */

async function tutorsWithLivePets(
  tx: TenantTransaction,
  ids: string[],
): Promise<Set<string>> {
  const rows = await tx.petTutor.findMany({
    where: { tutorId: { in: ids }, unlinkedAt: null, pet: { status: 'ACTIVE', deletedAt: null } },
    select: { tutorId: true },
    distinct: ['tutorId'],
  })
  return new Set(rows.map((row) => row.tutorId))
}

/**
 * Quem aceita marketing em **algum** canal.
 *
 * A tabela é append-only e guarda a história inteira, então o que vale é a última linha
 * de cada par (tutor, canal) — a mesma leitura de `consent.ts` no messaging-service, e
 * pela mesma razão: revogar não apaga o opt-in anterior.
 *
 * "Algum canal" e não "o canal escolhido" porque a campanha costuma ir em `AUTO`, e a
 * cascata do motor é que decide por onde sai. Quem aceita e-mail mas não WhatsApp entra
 * na mira e recebe por e-mail.
 */
async function tutorsConsentingToMarketing(
  tx: TenantTransaction,
  ids: string[],
): Promise<Set<string>> {
  const rows = await tx.tutorConsent.findMany({
    where: { tutorId: { in: ids }, channel: { in: ['WHATSAPP', 'EMAIL'] } },
    orderBy: { createdAt: 'desc' },
    select: { tutorId: true, channel: true, granted: true, purpose: true },
  })

  const seen = new Set<string>()
  const consenting = new Set<string>()

  for (const row of rows) {
    const key = `${row.tutorId}:${row.channel}`
    if (seen.has(key)) continue
    seen.add(key)
    if (row.granted && (row.purpose === 'MARKETING' || row.purpose === 'BOTH')) {
      consenting.add(row.tutorId)
    }
  }

  return consenting
}

/**
 * Quem já recebeu marketing nos últimos sete dias.
 *
 * O teto em si é do tenant (`messaging_settings.marketing_weekly_cap`), e é o
 * messaging-service quem o cobra de verdade — aqui a pergunta é feita **de novo** só
 * para a prévia poder contar. Um alvo que o motor bloquearia aparecendo como "vai
 * receber" faria o número da prévia não bater com o do resultado, e é esse número que a
 * confirmação de contagem protege.
 */
async function tutorsAtWeeklyCap(
  tx: TenantTransaction,
  ids: string[],
  now: Date,
): Promise<Set<string>> {
  const settings = await tx.messagingSettings.findFirst({ select: { marketingWeeklyCap: true } })
  const cap = settings?.marketingWeeklyCap ?? 1
  if (cap <= 0) return new Set()

  const rows = await tx.message.groupBy({
    by: ['tutorId'],
    where: {
      tutorId: { in: ids },
      direction: 'OUTBOUND',
      category: 'MARKETING',
      status: { in: [...COUNTED_STATUSES] },
      createdAt: { gte: daysAgo(now, 7) },
    },
    _count: { _all: true },
  })

  return new Set(rows.filter((row) => row._count._all >= cap).map((row) => row.tutorId))
}

/** AC-02 de MOD-CRM-07: quem entrou na mira **desta** campanha dentro da carência. */
async function tutorsInCooldown(
  tx: TenantTransaction,
  ids: string[],
  campaignId: string,
  since: Date,
): Promise<Set<string>> {
  const rows = await tx.campaignTarget.findMany({
    where: {
      tutorId: { in: ids },
      createdAt: { gte: since },
      run: { campaignId },
      // Quem foi pulado não gastou a carência: ele não recebeu nada, e trancá-lo por
      // sessenta dias por causa de um bloqueio que já passou seria puni-lo duas vezes.
      status: 'SENT',
    },
    select: { tutorId: true },
    distinct: ['tutorId'],
  })
  return new Set(rows.map((row) => row.tutorId))
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 3_600_000)
}
