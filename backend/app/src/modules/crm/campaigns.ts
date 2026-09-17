import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  CampaignSegmentSchema,
  findTemplateDefinition,
  templateLabelOf,
  type CampaignPreview,
  type CampaignRunSummary,
  type CampaignSegment,
  type CampaignSkipReason,
  type CampaignSummary,
  type CampaignTargetRow,
  type CampaignType,
  type CreateCampaignInput,
  type MessageChannelPref,
  type UpdateCampaignInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { tenantHasFeature } from '../../shared/plan.js'
import {
  campaignBusy,
  emptySegment,
  invalid,
  notFound,
  targetCountMismatch,
  unknownTemplate,
} from './errors.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { getMessagingPort } from './messaging-port.js'
import { resolveSegment, type Candidate } from './segments.js'
import { petListsOf } from './tutor-vars.js'

/**
 * Campanhas (MOD-CRM-07 e MOD-CRM-12).
 *
 * Três coisas deste arquivo valem ser ditas antes do código:
 *
 * 1. **O segmento é resolvido no disparo, nunca antes.** A prévia e o disparo chamam a
 *    mesma `resolveSegment` com o mesmo relógio da requisição, e é por isso que os dois
 *    números podem divergir — quando divergem, o disparo é recusado (AC-02 de
 *    MOD-CRM-12) em vez de mandar para uma lista que ninguém aprovou.
 * 2. **Todo alvo vira linha**, inclusive o pulado. `campaign_targets` é a prestação de
 *    contas da campanha, e uma pessoa que sumiu sem linha é uma pergunta sem resposta na
 *    tela de resultados.
 * 3. **A campanha não envia nada.** Ela decide quem, e pede ao messaging-service. É o
 *    mesmo desenho de `reminders.ts`, e o que garante que consentimento, supressão,
 *    janela de silêncio e tetos valham igual para campanha e para lembrete.
 */

/** Um lote de alvos por transação: uma campanha de mil não cabe numa transação só. */
const TARGET_CHUNK = 100

export async function listCampaigns(tenantId: string): Promise<CampaignSummary[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    })
    return rows.map(toSummary)
  })
}

export async function getCampaign(tenantId: string, id: string): Promise<CampaignSummary> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.campaign.findUnique({
      where: { id },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    })
    if (!row) throw notFound('Campanha não encontrada')
    return toSummary(row)
  })
}

export async function createCampaign(
  actor: ActorContext,
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  assertMarketingTemplate(input.templateKey)

  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.campaign.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          type: 'MANUAL',
          status: input.scheduledFor ? 'SCHEDULED' : 'DRAFT',
          templateKey: input.templateKey,
          channel: input.channel,
          segment: input.segment,
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
          createdBy: actor.actorUserId ?? null,
        },
        include: { runs: true },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'campaign.created',
        entity: 'campaigns',
        entityId: row.id,
        after: { name: row.name, templateKey: row.templateKey, segment: input.segment },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return row
    },
    tenantOptions(actor),
  )

  return toSummary({ ...created, runs: [] })
}

export async function updateCampaign(
  actor: ActorContext,
  id: string,
  input: UpdateCampaignInput,
): Promise<CampaignSummary> {
  if (input.templateKey) assertMarketingTemplate(input.templateKey)

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.campaign.findUnique({ where: { id } })
      if (!before) throw notFound('Campanha não encontrada')

      // Rascunho e agendada se editam; o resto, não. Editar o segmento de uma campanha
      // que já rodou reescreveria a pergunta depois de a resposta ter saído, e os
      // números do run passado passariam a descrever um filtro que nunca existiu.
      if (before.status !== 'DRAFT' && before.status !== 'SCHEDULED') {
        throw campaignBusy(`Esta campanha está em ${before.status} e não pode mais ser editada`)
      }

      const scheduledFor =
        input.scheduledFor === undefined
          ? before.scheduledFor
          : input.scheduledFor
            ? new Date(input.scheduledFor)
            : null

      const row = await tx.campaign.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          ...(input.segment !== undefined ? { segment: input.segment } : {}),
          scheduledFor,
          status: scheduledFor ? 'SCHEDULED' : 'DRAFT',
        },
        include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'campaign.updated',
        entity: 'campaigns',
        entityId: id,
        before: { name: before.name, templateKey: before.templateKey, segment: before.segment },
        after: { name: row.name, templateKey: row.templateKey, segment: row.segment },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return toSummary(row)
    },
    tenantOptions(actor),
  )
}

export async function previewCampaign(
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<CampaignPreview> {
  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id } })
    if (!campaign) throw notFound('Campanha não encontrada')

    const candidates = await resolveSegment(tx, parseSegment(campaign.segment), { now })
    return summarize(candidates)
  })
}

export function summarize(candidates: Candidate[]): CampaignPreview {
  const skippedByReason: Partial<Record<CampaignSkipReason, number>> = {}
  let eligible = 0

  for (const candidate of candidates) {
    if (candidate.skipReason) {
      skippedByReason[candidate.skipReason] = (skippedByReason[candidate.skipReason] ?? 0) + 1
    } else {
      eligible += 1
    }
  }

  return {
    targeted: candidates.length,
    eligible,
    skipped: candidates.length - eligible,
    skippedByReason: skippedByReason as Record<CampaignSkipReason, number>,
    // A amostra é de quem **vai receber**. Uma amostra que mistura pulados faria a
    // pessoa reconhecer nomes que não recebem nada, e é a leitura mais perigosa que uma
    // tela de disparo pode induzir.
    sample: candidates
      .filter((candidate) => !candidate.skipReason)
      .slice(0, 10)
      .map((candidate) => ({ tutorId: candidate.tutorId, name: candidate.name })),
  }
}

export interface RunResult {
  runId: string
  targeted: number
  sent: number
  skipped: number
  failed: number
}

/**
 * Dispara — e é a única operação irreversível do módulo.
 *
 * `expectedTargets` é a rede: o número que a pessoa viu precisa ser o que vai sair. A
 * comparação é sobre os **elegíveis**, não sobre o total da mira, porque é o elegível
 * que vira mensagem — dizer "340" e mandar para 300 seria assustar quem confirma e
 * mentir para quem lê o resultado.
 */
export async function runCampaign(
  actor: ActorContext,
  id: string,
  expectedTargets: number,
  now: Date = new Date(),
): Promise<RunResult> {
  const campaign = await withTenant(actor.tenantId, async (tx) => {
    const row = await tx.campaign.findUnique({ where: { id } })
    if (!row) throw notFound('Campanha não encontrada')
    if (row.status === 'RUNNING') throw campaignBusy('Esta campanha já está em execução')
    if (row.status === 'DONE' || row.status === 'CANCELLED') {
      throw campaignBusy(`Esta campanha está em ${row.status} e não roda de novo`)
    }
    return row
  })

  const candidates = await withTenant(actor.tenantId, (tx) =>
    resolveSegment(tx, parseSegment(campaign.segment), { now }),
  )
  const preview = summarize(candidates)

  if (preview.targeted === 0) throw emptySegment()
  if (preview.eligible !== expectedTargets) {
    throw targetCountMismatch(expectedTargets, preview.eligible)
  }

  const runId = await openRun(actor.tenantId, campaign.id, now)

  /**
   * O `catch` existe por causa do `openRun` logo acima.
   *
   * Ele move a campanha para `RUNNING`, e `RUNNING` é um dos estados que a guarda no
   * topo desta função recusa. Uma exceção no meio da entrega — o banco caiu na
   * gravação dos alvos — deixaria a campanha **presa para sempre**: nem roda, porque
   * está rodando, nem se edita, porque não é rascunho. `FAILED` é um estado do qual se
   * sai criando outra campanha, e ele diz a verdade sobre o que aconteceu.
   */
  let result: Awaited<ReturnType<typeof deliver>>
  try {
    result = await deliver(actor.tenantId, {
      runId,
      campaignId: campaign.id,
      templateKey: campaign.templateKey,
      channel: campaign.channel as MessageChannelPref,
      candidates,
    })
  } catch (error) {
    await withTenant(actor.tenantId, async (tx) => {
      await tx.campaign.update({ where: { id }, data: { status: 'FAILED' } })
      await tx.campaignRun.update({ where: { id: runId }, data: { finishedAt: now } })
    }).catch(() => undefined)
    throw error
  }

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await closeRun(tx, runId, result, now)
      // `DONE` mesmo com falhas: a campanha rodou, e o que falhou está em
      // `campaign_targets` com nome e motivo. `FAILED` é para a campanha que não
      // conseguiu começar — texto desativado, segmento vazio —, e confundir as duas
      // faria o painel gritar por vinte bloqueios de consentimento perfeitamente normais.
      await tx.campaign.update({ where: { id }, data: { status: 'DONE' } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'campaign.ran',
        entity: 'campaigns',
        entityId: id,
        after: { runId, ...result },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  logger.info({ tenantId: actor.tenantId, campaignId: id, ...result }, 'campanha disparada')
  return { runId, ...result }
}

/**
 * AC-03 de MOD-CRM-12: cancelar em andamento.
 *
 * O que já foi entregue **não volta atrás** — e é por isso que o cancelamento age sobre
 * `messages` e não sobre `campaign_targets`: quem ainda está em `QUEUED`/`SCHEDULED` vai
 * a `CANCELLED`, e quem já saiu fica como está. Os alvos guardam o que aconteceu, que é
 * o registro histórico; mexer neles seria reescrever o passado.
 */
export async function cancelCampaign(actor: ActorContext, id: string): Promise<number> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id },
        include: { runs: { select: { id: true } } },
      })
      if (!campaign) throw notFound('Campanha não encontrada')
      if (campaign.status === 'CANCELLED') return 0

      const runIds = campaign.runs.map((run) => run.id)
      let cancelled = 0

      if (runIds.length > 0) {
        const targets = await tx.campaignTarget.findMany({
          where: { runId: { in: runIds }, messageId: { not: null } },
          select: { messageId: true },
        })
        const messageIds = targets
          .map((target) => target.messageId)
          .filter((value): value is string => value !== null)

        if (messageIds.length > 0) {
          const { count } = await tx.message.updateMany({
            where: { id: { in: messageIds }, status: { in: ['QUEUED', 'SCHEDULED'] } },
            data: { status: 'CANCELLED' },
          })
          cancelled = count
        }
      }

      await tx.campaign.update({ where: { id }, data: { status: 'CANCELLED' } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'campaign.cancelled',
        entity: 'campaigns',
        entityId: id,
        after: { cancelledMessages: cancelled },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return cancelled
    },
    tenantOptions(actor),
  )
}

/**
 * As campanhas manuais que chegaram na hora marcada.
 *
 * **Não passam pela confirmação de contagem**, e é uma diferença consciente do disparo
 * pela tela: `expectedTargets` protege contra a lista ter mudado entre a prévia e o
 * clique, e num disparo agendado não há ninguém olhando para uma prévia. Quem agendou
 * aceitou o segmento, não um número — e recusar o disparo às três da manhã porque a base
 * cresceu em dois tutores seria transformar a proteção em pane silenciosa.
 */
export async function runScheduledCampaigns(now: Date = new Date()): Promise<number> {
  const due = await getMaintenancePrisma().$queryRaw<{ id: string; tenant_id: string }[]>`
    SELECT id, tenant_id FROM campaigns
     WHERE status = 'SCHEDULED'
       AND type = 'MANUAL'
       AND scheduled_for IS NOT NULL
       AND scheduled_for <= ${now}
     LIMIT 50
  `

  let fired = 0
  for (const row of due) {
    try {
      // Fica `SCHEDULED`, e não `CANCELLED`: se o plano voltar, a campanha dispara na
      // varredura seguinte. Descer de plano não apaga o que o petshop preparou.
      if (!(await tenantHasFeature(row.tenant_id, 'CAMPAIGNS'))) continue

      const candidates = await withTenant(row.tenant_id, async (tx) => {
        const campaign = await tx.campaign.findUnique({ where: { id: row.id } })
        if (!campaign) return null
        return {
          campaign,
          candidates: await resolveSegment(tx, parseSegment(campaign.segment), { now }),
        }
      })
      if (!candidates) continue

      const runId = await openRun(row.tenant_id, row.id, now)
      const totals = await deliver(row.tenant_id, {
        runId,
        campaignId: row.id,
        templateKey: candidates.campaign.templateKey,
        channel: candidates.campaign.channel as MessageChannelPref,
        candidates: candidates.candidates,
      })

      await withTenant(row.tenant_id, async (tx) => {
        await closeRun(tx, runId, totals, now)
        await tx.campaign.update({ where: { id: row.id }, data: { status: 'DONE' } })
      })

      fired += 1
      logger.info({ tenantId: row.tenant_id, campaignId: row.id, ...totals }, 'campanha agendada disparada')
    } catch (error) {
      // A campanha que estourou vai a `FAILED` e não fica presa em `SCHEDULED` — senão o
      // job a reprocessaria de hora em hora, para sempre, com a mesma falha.
      logger.error({ err: error, campaignId: row.id }, 'falha ao disparar campanha agendada')
      await withTenant(row.tenant_id, (tx) =>
        tx.campaign.update({ where: { id: row.id }, data: { status: 'FAILED' } }),
      ).catch(() => undefined)
    }
  }

  return fired
}

export async function listRuns(tenantId: string, campaignId: string): Promise<CampaignRunSummary[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.campaignRun.findMany({
      where: { campaignId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    })
    return rows.map(toRunSummary)
  })
}

export async function listTargets(tenantId: string, runId: string): Promise<CampaignTargetRow[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.campaignTarget.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
      take: 1_000,
      include: { tutor: { select: { fullName: true } } },
    })

    return rows.map((row) => ({
      id: row.id,
      tutorId: row.tutorId,
      tutorName: row.tutor.fullName,
      status: row.status,
      skipReason: row.skipReason,
      messageId: row.messageId,
      createdAt: row.createdAt.toISOString(),
    }))
  })
}

// ─── O disparo ───────────────────────────────────────────────────────────────

export interface DeliveryPlan {
  runId: string
  campaignId: string
  templateKey: string
  channel: MessageChannelPref
  candidates: Candidate[]
}

/**
 * Pede o enfileiramento de cada elegível e grava a linha de todo alvo.
 *
 * Roda **fora** de uma transação longa de propósito. Cada enfileiramento é um salto HTTP
 * ao messaging-service, e mil deles dentro de uma transação segurariam uma conexão do
 * pool por minutos, com RLS ligada, enquanto o resto do serviço espera. As linhas de
 * alvo são gravadas em lotes, e um lote perdido custa a prestação de contas de cem
 * pessoas — não o disparo delas.
 */
export async function deliver(
  tenantId: string,
  plan: DeliveryPlan,
): Promise<{ targeted: number; sent: number; skipped: number; failed: number }> {
  const port = getMessagingPort()

  // A frase de todos de uma vez, antes do laço: dentro dele cada iteração já custa um
  // salto HTTP, e somar uma transação de banco a cada um dobraria o tempo do disparo
  // sem trazer nada.
  const petLists = await withTenant(tenantId, (tx) =>
    petListsOf(
      tx,
      plan.candidates.filter((candidate) => !candidate.skipReason).map((c) => c.tutorId),
    ),
  )

  const rows: {
    tutorId: string
    status: 'SENT' | 'SKIPPED' | 'FAILED'
    skipReason: CampaignSkipReason | null
    messageId: string | null
  }[] = []

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const candidate of plan.candidates) {
    if (candidate.skipReason) {
      rows.push({
        tutorId: candidate.tutorId,
        status: 'SKIPPED',
        skipReason: candidate.skipReason,
        messageId: null,
      })
      skipped += 1
      continue
    }

    const outcome = await port.enqueue({
      tenantId,
      tutorId: candidate.tutorId,
      templateKey: plan.templateKey,
      channel: plan.channel,
      // A execução é a âncora: reexecutar a campanha alcança a mesma pessoa de novo, o
      // que é o ponto de uma campanha recorrente. O que impede a repetição indevida é a
      // carência, não a idempotência.
      dedupeKey: `campaign:${plan.runId}:${candidate.tutorId}`,
      originType: 'CAMPAIGN_RUN',
      originId: plan.runId,
      variables: { 'pets.lista': petLists.get(candidate.tutorId) ?? '' },
    })

    if (!outcome) {
      rows.push({
        tutorId: candidate.tutorId,
        status: 'FAILED',
        skipReason: 'ENQUEUE_FAILED',
        messageId: null,
      })
      failed += 1
      continue
    }

    // O motor tem a palavra final: ele revalida supressão e disponibilidade de canal,
    // que a classificação daqui não sabe consultar. Um `BLOCKED` que volta é informação
    // legítima, não erro — e vira o mesmo `SKIPPED` que a prévia já sabia nomear.
    if (outcome.status === 'BLOCKED') {
      rows.push({
        tutorId: candidate.tutorId,
        status: 'SKIPPED',
        skipReason: mapBlockReason(outcome.blockReason),
        messageId: outcome.messageId || null,
      })
      skipped += 1
      continue
    }

    rows.push({
      tutorId: candidate.tutorId,
      status: 'SENT',
      skipReason: null,
      messageId: outcome.messageId || null,
    })
    sent += 1
  }

  for (let index = 0; index < rows.length; index += TARGET_CHUNK) {
    const chunk = rows.slice(index, index + TARGET_CHUNK)
    await withTenant(tenantId, (tx) =>
      tx.campaignTarget.createMany({
        data: chunk.map((row) => ({ tenantId, runId: plan.runId, ...row })),
      }),
    )
  }

  return { targeted: plan.candidates.length, sent, skipped, failed }
}

export async function openRun(tenantId: string, campaignId: string, now: Date): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'RUNNING' } })
    const run = await tx.campaignRun.create({
      data: { tenantId, campaignId, startedAt: now },
      select: { id: true },
    })
    return run.id
  })
}

export async function closeRun(
  tx: TenantTransaction,
  runId: string,
  totals: { targeted: number; sent: number; skipped: number; failed: number },
  now: Date,
): Promise<void> {
  await tx.campaignRun.update({ where: { id: runId }, data: { ...totals, finishedAt: now } })
}

// ─── Auxiliares ──────────────────────────────────────────────────────────────

/**
 * O motivo do motor, traduzido para o vocabulário da campanha.
 *
 * Os dois conjuntos existem separados porque respondem a perguntas diferentes — "por que
 * esta mensagem não saiu" e "por que esta pessoa ficou de fora" —, e a tradução é
 * pequena de propósito: o que não tiver correspondência vira `ENQUEUE_FAILED`, que é
 * honesto, em vez de um motivo parecido que induziria a recepção a consertar a coisa
 * errada.
 */
function mapBlockReason(reason: string | null): CampaignSkipReason {
  switch (reason) {
    case 'NO_CONSENT':
      return 'NO_CONSENT'
    case 'SUPPRESSED':
      return 'SUPPRESSED'
    case 'NO_CHANNEL':
      return 'NO_CHANNEL'
    case 'PET_DECEASED':
      return 'PET_DECEASED'
    case 'WEEKLY_CAP':
      return 'WEEKLY_CAP'
    default:
      return 'ENQUEUE_FAILED'
  }
}

/**
 * Campanha só manda texto de `MARKETING`.
 *
 * A guarda não é burocracia: `campaign_broadcast` e `winback` contam no teto semanal e
 * exigem consentimento, e um `appointment_reminder` disparado para trezentas pessoas
 * passaria por cima dos dois — mandando "seu banho é amanhã" para quem não marcou nada.
 */
function assertMarketingTemplate(key: string): void {
  const definition = findTemplateDefinition(key)
  if (!definition) throw unknownTemplate(`Não existe um texto chamado "${key}"`)
  if (definition.category !== 'MARKETING') {
    throw invalid('Uma campanha só pode usar um texto de marketing')
  }
}

function parseSegment(raw: unknown): CampaignSegment {
  const parsed = CampaignSegmentSchema.safeParse(raw ?? {})
  // Uma `segment` ilegível não pode virar "todo mundo": a queda segura de um filtro
  // corrompido é o filtro mais restritivo que existe, não o mais amplo.
  return parsed.success ? parsed.data : { excludeDebtors: true, requiresActivePet: true }
}

interface CampaignRow {
  id: string
  name: string
  type: CampaignType
  status: string
  templateKey: string
  channel: string
  segment: unknown
  scheduledFor: Date | null
  createdAt: Date
  runs: {
    id: string
    campaignId: string
    startedAt: Date
    finishedAt: Date | null
    targeted: number
    sent: number
    skipped: number
    failed: number
  }[]
}

function toSummary(row: CampaignRow): CampaignSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status as CampaignSummary['status'],
    templateKey: row.templateKey,
    templateLabel: templateLabelOf(row.templateKey),
    channel: row.channel as CampaignSummary['channel'],
    segment: parseSegment(row.segment),
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastRun: row.runs[0] ? toRunSummary(row.runs[0]) : null,
  }
}

function toRunSummary(row: CampaignRow['runs'][number]): CampaignRunSummary {
  return {
    id: row.id,
    campaignId: row.campaignId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    targeted: row.targeted,
    sent: row.sent,
    skipped: row.skipped,
    failed: row.failed,
  }
}
