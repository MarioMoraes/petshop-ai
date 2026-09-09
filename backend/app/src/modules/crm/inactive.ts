import { withTenant, type TenantTransaction } from '@petshop/db'
import { INACTIVE_CAMPAIGN_NAME, type MessageChannelPref } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { closeRun, deliver, openRun, summarize } from './campaigns.js'
import { forEachDueTenant, type DailySummary, type TenantRun } from './daily.js'
import { resolveSegment } from './segments.js'

/**
 * A campanha de inativos (MOD-CRM-07).
 *
 * É a única campanha que **ninguém monta**: nasce da automação `inactive_campaign`, com
 * o segmento derivado da configuração dela — dias de inatividade e carência. Por isso a
 * linha em `campaigns` é criada na primeira execução do tenant e reaproveitada em todas
 * as seguintes: `campaign_runs` exige uma campanha, e é a série de runs que mostra se a
 * reativação está funcionando.
 *
 * **A seleção é feita no instante da execução** (AC-03), nunca de uma lista congelada.
 * E o AC-03 tem uma sutileza que o texto dele não entrega de graça: quem *agendou* ainda
 * não *foi atendido*, e `last_attendance_at` só se move no check-out. Filtrar apenas por
 * ele mandaria o convite de volta na véspera do banho que a pessoa acabou de marcar — por
 * isso a seleção pergunta também por agendamento futuro (ver `hasUpcoming`).
 */

export async function runInactiveCampaign(now: Date = new Date()): Promise<DailySummary> {
  const summary = await forEachDueTenant('inactive_campaign', now, (run, totals) =>
    inactiveForTenant(run, totals, now),
  )
  if (summary.enqueued > 0) logger.info(summary, 'convites de volta enfileirados')
  return summary
}

async function inactiveForTenant(
  run: TenantRun,
  summary: DailySummary,
  now: Date,
): Promise<void> {
  const inactiveDays = Number(run.automation.config.inactiveDays ?? 90)
  const cooldownDays = Number(run.automation.config.cooldownDays ?? 60)

  const campaignId = await ensureSystemCampaign(run.tenantId, {
    templateKey: run.automation.templateKey,
    channel: run.automation.channel,
    inactiveDays,
  })

  const candidates = await withTenant(run.tenantId, async (tx) => {
    const resolved = await resolveSegment(
      tx,
      {
        inactiveDaysMin: inactiveDays,
        // AC-05: quem deve é assunto da régua de cobrança, não de oferta de volta.
        excludeDebtors: true,
        requiresActivePet: true,
      },
      { campaignId, cooldownDays, now },
    )

    // AC-03 — "voltou sozinho". Quem já tem horário marcado não precisa de convite, e
    // `last_attendance_at` não o denuncia: ele só se move no check-out, dias depois de a
    // pessoa ter voltado. Sem esta pergunta, o convite chegaria na véspera do banho.
    const upcoming = await hasUpcoming(
      tx,
      resolved.map((candidate) => candidate.tutorId),
      now,
    )
    return resolved.filter((candidate) => !upcoming.has(candidate.tutorId))
  })

  const preview = summarize(candidates)
  summary.scanned += preview.targeted
  if (preview.targeted === 0) return

  const runId = await openRun(run.tenantId, campaignId, now)

  const totals = await deliver(run.tenantId, {
    runId,
    campaignId,
    templateKey: run.automation.templateKey,
    channel: run.automation.channel,
    candidates,
  })

  await withTenant(run.tenantId, async (tx) => {
    await closeRun(tx, runId, totals, now)
    // Volta a `SCHEDULED`, e não a `DONE`: esta campanha roda de novo amanhã. `DONE`
    // diria que a reativação acabou, e ela não acaba enquanto a automação estiver ligada.
    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'SCHEDULED' } })
  })

  summary.enqueued += totals.sent
  summary.skipped += totals.skipped + totals.failed
}

/**
 * A campanha de sistema do tenant — criada uma vez, reaproveitada sempre.
 *
 * O segmento gravado aqui é **descritivo**, não normativo: quem manda na execução é a
 * `config` da automação, lida a cada passada. Gravá-lo mesmo assim é o que faz a tela de
 * campanhas mostrar a reativação junto das manuais, com o filtro que ela usa — uma linha
 * sem segmento apareceria como "todo mundo", que é a leitura mais alarmante possível.
 */
async function ensureSystemCampaign(
  tenantId: string,
  options: { templateKey: string; channel: MessageChannelPref; inactiveDays: number },
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.campaign.findFirst({
      where: { type: 'INACTIVE' },
      select: { id: true },
    })

    const segment = {
      inactiveDaysMin: options.inactiveDays,
      excludeDebtors: true,
      requiresActivePet: true,
    }

    if (existing) {
      await tx.campaign.update({
        where: { id: existing.id },
        data: { templateKey: options.templateKey, channel: options.channel, segment },
      })
      return existing.id
    }

    const created = await tx.campaign.create({
      data: {
        tenantId,
        name: INACTIVE_CAMPAIGN_NAME,
        type: 'INACTIVE',
        status: 'SCHEDULED',
        templateKey: options.templateKey,
        channel: options.channel,
        segment,
        // Sem autor: quem criou foi a automação, e atribuir a campanha a quem por acaso
        // a ligou faria a trilha mentir sobre quem disparou cada run.
        createdBy: null,
      },
      select: { id: true },
    })
    return created.id
  })
}

/** Quem tem horário marcado daqui para frente. */
async function hasUpcoming(
  tx: TenantTransaction,
  tutorIds: string[],
  now: Date,
): Promise<Set<string>> {
  if (tutorIds.length === 0) return new Set()

  const rows = await tx.appointment.findMany({
    where: {
      tutorId: { in: tutorIds },
      startsAt: { gte: now },
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] },
    },
    select: { tutorId: true },
    distinct: ['tutorId'],
  })

  return new Set(rows.map((row) => row.tutorId))
}
