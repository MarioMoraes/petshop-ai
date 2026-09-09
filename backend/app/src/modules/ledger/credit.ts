import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import { formatBRL, type CreditCheckResponse } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { logger, recordMetric } from '../../shared/logger.js'
import type { ActorContext } from './actor.js'
import { accountSummary } from './entries.js'
import { loadSettings } from './settings.js'

/**
 * Limite de crédito e inadimplência (MOD-LEDGER-09).
 *
 * As duas metades respondem a perguntas diferentes, e confundi-las é o erro que este
 * módulo existe para não cometer:
 *
 * - **O limite** olha o *valor*: quanto o tutor já deve, e se o que ele quer agendar
 *   cabe. É opt-in (RN-15) — sem limite configurado, nada bloqueia.
 * - **A inadimplência** olha o *tempo*: há quantos dias o débito mais antigo está
 *   aberto. Quem fez banho de manhã e paga na saída deve dinheiro o dia inteiro sem
 *   ser inadimplente.
 */

/**
 * AC-01 a AC-03 — o que a agenda pergunta antes de marcar.
 *
 * Devolve **sempre 200**. Recusar com erro obrigaria a agenda a tratar exceção para
 * saber algo que ela quer só exibir; quem transforma isso em bloqueio é
 * `assertCreditAllowed`, do outro lado, no momento de gravar.
 */
export async function creditCheck(
  actor: ActorContext,
  tutorId: string,
  amountCents: number,
): Promise<CreditCheckResponse> {
  return withTenant(actor.tenantId, async (tx) => {
    const [summary, settings] = await Promise.all([
      accountSummary(tx, actor.tenantId, tutorId),
      loadSettings(tx, actor.tenantId),
    ])

    const balanceCents = summary.balanceCents
    const projectedCents = balanceCents - amountCents
    const limitCents = settings.creditLimitCents

    const debtCents = Math.max(0, -balanceCents)
    const projectedDebtCents = Math.max(0, -projectedCents)
    const overdueDays = daysSince(summary.oldestOpenDebitAt)

    // AC-03: limite nulo nunca bloqueia. A política é opt-in por tenant.
    const blocked = limitCents !== null && projectedDebtCents > limitCents

    return {
      allowed: !blocked,
      // O aviso é independente do bloqueio: a recepção precisa saber do débito mesmo
      // quando ele não impede nada, para poder cobrar com o tutor na frente.
      warning: debtCents > 0,
      requiresOverride: blocked,
      balanceCents,
      projectedCents,
      limitCents,
      overdueDays,
      message: buildMessage({ debtCents, projectedDebtCents, limitCents, overdueDays, blocked }),
    }
  })
}

function buildMessage(input: {
  debtCents: number
  projectedDebtCents: number
  limitCents: number | null
  overdueDays: number
  blocked: boolean
}): string {
  if (input.blocked) {
    return `Este agendamento levaria o débito a ${formatBRL(input.projectedDebtCents)}, acima do limite de ${formatBRL(input.limitCents ?? 0)}`
  }
  if (input.debtCents === 0) return 'Conta em dia'

  const atraso =
    input.overdueDays > 0
      ? ` — o mais antigo há ${input.overdueDays} dia${input.overdueDays === 1 ? '' : 's'}`
      : ''
  return `Tutor possui débito de ${formatBRL(input.debtCents)}${atraso}`
}

function daysSince(date: Date | null): number {
  if (!date) return 0
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000))
}

// ─── AC-04 — o job de inadimplência ──────────────────────────────────────────

interface OverdueCandidate {
  id: string
  tenant_id: string
  tutor_id: string
  balance_cents: bigint
  overdue_since: Date | null
  oldest_open_debit_at: Date | null
}

/**
 * Varre as contas e move a inadimplência nos **dois sentidos**.
 *
 * RN-16 é explícito em que a tag entra e sai sozinha. Uma tag que só entra é pior que
 * tag nenhuma: o petshop para de confiar nela, e a régua de cobrança do MOD-CRM passa a
 * perseguir quem já pagou.
 *
 * Descobrir é cross-tenant (`app_maintenance`); agir acontece dentro de `withTenant`.
 */
export async function detectOverdue(
  now: Date = new Date(),
): Promise<{ detected: number; resolved: number }> {
  // Uma consulta só, com o débito aberto mais antigo por conta: iterar tenants e depois
  // contas daria N+1 sobre a tabela que mais cresce do módulo.
  const rows = await getMaintenancePrisma().$queryRaw<OverdueCandidate[]>`
    SELECT a.id, a.tenant_id, a.tutor_id, a.balance_cents, a.overdue_since,
           (SELECT MIN(e.occurred_at)
              FROM ledger_entries e
             WHERE e.account_id = a.id
               AND e.direction = 'DEBIT'
               AND e.status = 'POSTED'
               AND e.settled_cents < e.amount_cents) AS oldest_open_debit_at
      FROM ledger_accounts a
     WHERE a.balance_cents < 0 OR a.overdue_since IS NOT NULL
     ORDER BY a.tenant_id
     LIMIT 2000
  `

  // `overdue_days` é por tenant; ler uma vez por conta faria a mesma consulta dezenas
  // de vezes seguidas.
  const thresholds = new Map<string, number>()
  let detected = 0
  let resolved = 0

  for (const row of rows) {
    try {
      let overdueDays = thresholds.get(row.tenant_id)
      if (overdueDays === undefined) {
        overdueDays = await withTenant(row.tenant_id, async (tx) =>
          (await loadSettings(tx, row.tenant_id)).overdueDays,
        )
        thresholds.set(row.tenant_id, overdueDays)
      }

      const oldest = row.oldest_open_debit_at
      const ageDays = oldest ? Math.floor((now.getTime() - oldest.getTime()) / 86_400_000) : 0
      const shouldBeOverdue = oldest !== null && ageDays >= overdueDays
      const isOverdue = row.overdue_since !== null

      if (shouldBeOverdue && !isOverdue) {
        await markOverdue(row, oldest, ageDays)
        detected += 1
      } else if (!shouldBeOverdue && isOverdue) {
        await clearOverdue(row, now)
        resolved += 1
      }
    } catch (error) {
      // Uma conta que não pôde ser avaliada não impede a avaliação das outras.
      logger.error({ err: error, accountId: row.id }, 'falha ao avaliar inadimplência')
    }
  }

  if (detected > 0 || resolved > 0) {
    recordMetric({ metric: 'overdue_detected_total', value: detected, unit: 'count' })
    recordMetric({ metric: 'overdue_resolved_total', value: resolved, unit: 'count' })
  }

  return { detected, resolved }
}

async function markOverdue(
  row: OverdueCandidate,
  oldest: Date,
  overdueDays: number,
): Promise<void> {
  await withTenant(row.tenant_id, async (tx) => {
    await tx.ledgerAccount.update({
      where: { id: row.id },
      // `overdue_since` é a data do **débito**, não a de hoje: é ela que diz há quanto
      // tempo a dívida existe, e sobrescrevê-la a cada varredura zeraria a contagem.
      data: { overdueSince: oldest },
    })
    await recordAudit(tx, {
      tenantId: row.tenant_id,
      action: 'ledger.overdue_detected',
      entity: 'ledger_account',
      entityId: row.id,
      after: { tutorId: row.tutor_id, overdueDays, balanceCents: Number(row.balance_cents) },
    })
  })

  await publishEvent('inadimplencia.detectada', {
    tenantId: row.tenant_id,
    tutorId: row.tutor_id,
    balanceCents: Number(row.balance_cents),
    overdueDays,
    oldestOpenDebitAt: oldest.toISOString(),
  })
}

async function clearOverdue(row: OverdueCandidate, now: Date): Promise<void> {
  await withTenant(row.tenant_id, async (tx) => {
    await tx.ledgerAccount.update({
      where: { id: row.id },
      data: { overdueSince: null },
    })
    await recordAudit(tx, {
      tenantId: row.tenant_id,
      action: 'ledger.overdue_resolved',
      entity: 'ledger_account',
      entityId: row.id,
      after: { tutorId: row.tutor_id },
    })
  })

  await publishEvent('inadimplencia.resolvida', {
    tenantId: row.tenant_id,
    tutorId: row.tutor_id,
    settledAt: now.toISOString(),
  })
}

/** Reexportado para a rota montar a resposta sem reabrir a transação. */
export type { TenantTransaction }
