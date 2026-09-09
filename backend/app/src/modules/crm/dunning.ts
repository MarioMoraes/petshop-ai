import { withTenant } from '@petshop/db'
import { zonedMidnight, addDays } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { forEachDueTenant, type DailySummary, type TenantRun } from './daily.js'
import { getMessagingPort } from './messaging-port.js'
import { dunningVariables } from './tutor-vars.js'

/**
 * A régua de cobrança (MOD-CRM-08).
 *
 * O desenho em uma frase: **o degrau é função da idade da dívida, não do histórico de
 * envios**. Quem está há 12 dias em atraso recebe o segundo aviso, tenha ou não recebido
 * o primeiro — e é isso que faz a régua se comportar bem quando o petshop a liga no meio
 * do caminho, com uma base de inadimplentes de meses acumulados.
 *
 * O que impede a repetição é o `dedupeKey`, ancorado no **degrau** e no **lançamento
 * mais antigo em aberto**. Enquanto a dívida for a mesma, cada degrau sai uma vez. Uma
 * quitação parcial que zere o débito mais velho troca a âncora e a régua recomeça — o
 * que é o comportamento certo: a dívida que sobrou é outra, e mais nova.
 *
 * **A definição de "em aberto" é copiada do relatório de contas a receber**, de
 * propósito: débito `POSTED` com `settled_cents < amount_cents`, envelhecido por
 * `occurred_at`. Se as duas divergissem, o tutor que aparece na folha de quem vai ligar
 * não seria o mesmo que recebe a mensagem, e ninguém confiaria em nenhuma das duas.
 */

interface DebtorRow {
  tutor_id: string
  oldest_entry_id: string
  days_late: number
  open_cents: bigint
  balance_cents: number
}

interface Step {
  days: number
  templateKey: string
}

/**
 * O degrau que a idade da dívida alcançou — o de maior `days` que ela já ultrapassou.
 *
 * `null` antes do primeiro: uma dívida de ontem não é assunto da régua.
 */
export function stepFor(steps: Step[], daysLate: number): Step | null {
  const reached = steps
    .filter((step) => daysLate >= step.days)
    .sort((left, right) => right.days - left.days)
  return reached[0] ?? null
}

export async function runDunning(now: Date = new Date()): Promise<DailySummary> {
  const summary = await forEachDueTenant('dunning', now, dunningForTenant)
  if (summary.enqueued > 0) logger.info(summary, 'avisos de cobrança enfileirados')
  return summary
}

async function dunningForTenant(run: TenantRun, summary: DailySummary): Promise<void> {
  const steps = normalizeSteps(run.automation.config.steps)
  if (steps.length === 0) return

  const minDebtCents = Number(run.automation.config.minDebtCents ?? 2000)
  // O corte é o fim do dia civil do tenant, como no relatório: um débito de hoje de
  // manhã pertence a hoje, e um de ontem às 22h não pula para amanhã porque o servidor
  // está em UTC.
  const asOfEnd = zonedMidnight(addDays(run.today, 1), run.timezone)
  const firstStepDays = Math.min(...steps.map((step) => step.days))

  const rows = await withTenant(run.tenantId, (tx) =>
    tx.$queryRaw<DebtorRow[]>`
      SELECT t.id AS tutor_id,
             t.balance_cents,
             (SELECT e2.id
                FROM ledger_entries e2
               WHERE e2.tutor_id = t.id
                 AND e2.direction = 'DEBIT'
                 AND e2.status = 'POSTED'
                 AND e2.settled_cents < e2.amount_cents
               ORDER BY e2.occurred_at ASC
               LIMIT 1) AS oldest_entry_id,
             FLOOR(EXTRACT(EPOCH FROM (${asOfEnd}::timestamptz - MIN(e.occurred_at))) / 86400)::int
               AS days_late,
             SUM(e.amount_cents - e.settled_cents) AS open_cents
        FROM ledger_entries e
        JOIN tutors t ON t.id = e.tutor_id
       WHERE e.direction = 'DEBIT'
         AND e.status = 'POSTED'
         AND e.settled_cents < e.amount_cents
         AND e.occurred_at < ${asOfEnd}::timestamptz
         AND t.status = 'ACTIVE'
         AND t.deleted_at IS NULL
         -- Saldo negativo é dívida (RN-02 do MOD-LEDGER). Quem tem débito em aberto
         -- mas crédito não alocado maior que ele tem dinheiro com o petshop, e o
         -- despacho cancelaria a mensagem de qualquer forma — não vale criá-la.
         AND t.balance_cents < 0
       GROUP BY t.id, t.balance_cents
      HAVING SUM(e.amount_cents - e.settled_cents) >= ${minDebtCents}::bigint
         AND MIN(e.occurred_at) <= ${asOfEnd}::timestamptz - (${firstStepDays}::int * INTERVAL '1 day')
       ORDER BY MIN(e.occurred_at) ASC
       LIMIT 500
    `,
  )

  summary.scanned += rows.length

  const port = getMessagingPort()
  for (const row of rows) {
    const step = stepFor(steps, row.days_late)
    if (!step || !row.oldest_entry_id) {
      summary.skipped += 1
      continue
    }

    const ok = await port.enqueue({
      tenantId: run.tenantId,
      tutorId: row.tutor_id,
      templateKey: step.templateKey,
      channel: run.automation.channel,
      // Degrau + dívida. Enquanto a dívida mais velha for a mesma, cada degrau sai uma
      // vez só, por mais vezes que o job passe.
      dedupeKey: `dunning:${row.tutor_id}:${step.days}:${row.oldest_entry_id}`,
      // `LEDGER_ENTRY` é o que permite ao motor revalidar o saldo antes de enviar
      // (AC-03) sem precisar saber o que é uma régua de cobrança.
      originType: 'LEDGER_ENTRY',
      originId: row.oldest_entry_id,
      variables: dunningVariables({
        balanceCents: Number(row.open_cents),
        daysLate: row.days_late,
      }),
    })

    if (ok) summary.enqueued += 1
    else summary.skipped += 1
  }
}

/**
 * A régua, saneada.
 *
 * A `config` chega como JSON do banco, e o Zod só a valida na **escrita**. Uma linha
 * gravada antes de um campo existir, ou editada à mão, chegaria aqui com qualquer
 * coisa — e uma régua com um degrau inválido no meio é pior que uma régua desligada.
 */
function normalizeSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return []

  const steps: Step[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as { days?: unknown; templateKey?: unknown }
    if (typeof candidate.days !== 'number' || candidate.days < 1) continue
    if (typeof candidate.templateKey !== 'string' || candidate.templateKey.length === 0) continue
    steps.push({ days: Math.floor(candidate.days), templateKey: candidate.templateKey })
  }

  return steps.sort((left, right) => left.days - right.days)
}
