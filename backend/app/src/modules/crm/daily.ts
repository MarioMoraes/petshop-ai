import { getMaintenancePrisma, withTenant } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  automationPlanFeature,
  todayIn,
  type AutomationKey,
} from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { tenantHasFeature } from '../../shared/plan.js'
import { tenantOperational } from '../../shared/tenant-status.js'
import { resolveAutomation, type ResolvedAutomation } from './automations.js'

/**
 * O andaime das varreduras diárias da fatia 3.
 *
 * Aniversário, convite de volta e régua de cobrança são a mesma forma: **uma vez por
 * dia, na hora do petshop**. E "na hora do petshop" é o que impede a implementação
 * óbvia — um cron diário às 09:00 — de funcionar: nove da manhã de quem? O servidor roda
 * em UTC, e um petshop em Rio Branco receberia a felicitação às cinco da manhã.
 *
 * A solução é a mesma dos jobs do MOD-LEDGER: o cron roda **de hora em hora**, e cada
 * tenant só age quando o relógio dele marca a hora configurada. Custa 24 passadas por
 * dia em vez de uma, e cada passada de um tenant fora da hora é uma comparação de
 * inteiros.
 *
 * A **descoberta** é o outro proveito do desenho. Como as quatro automações nascem
 * desligadas, só existe linha em `automations` para quem foi lá e ligou — a varredura
 * cross-tenant é um `SELECT` sobre essa tabela, e um tenant que nunca ligou a régua não
 * custa uma consulta sequer.
 */

export interface DailySummary {
  tenants: number
  scanned: number
  enqueued: number
  skipped: number
}

export function emptySummary(): DailySummary {
  return { tenants: 0, scanned: 0, enqueued: 0, skipped: 0 }
}

/** A hora local do tenant, 0–23. */
export function localHour(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  // `hour12: false` devolve 24 à meia-noite em alguns runtimes; 24:00 é 00:00.
  return Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24
}

export interface TenantRun {
  tenantId: string
  timezone: string
  /** `YYYY-MM-DD` no fuso do tenant — a âncora de todo `dedupeKey` diário. */
  today: string
  automation: ResolvedAutomation
}

/**
 * Roda `handler` uma vez, hoje, para cada tenant que ligou a automação e cujo relógio
 * marca a hora configurada.
 *
 * Um tenant que estoure não pode travar os outros: é a mesma proteção da varredura de
 * lembretes, e vale ainda mais aqui, onde uma passada perdida é uma cobrança que não
 * saiu.
 */
export async function forEachDueTenant(
  key: AutomationKey,
  now: Date,
  handler: (run: TenantRun, summary: DailySummary) => Promise<void>,
): Promise<DailySummary> {
  const summary = emptySummary()

  const rows = await getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id FROM automations WHERE key = ${key} AND enabled = true
  `

  const feature = automationPlanFeature(key)

  for (const { tenant_id: tenantId } of rows) {
    try {
      // A automação ligada continua ligada quando o plano desce: o interruptor é do
      // petshop, e voltar ao Pro a religa sem ninguém reconfigurar. Quem cala é o plano.
      if (feature && !(await tenantHasFeature(tenantId, feature))) continue

      /**
       * A conta parada não convida ninguém a voltar.
       *
       * O despacho bloquearia de qualquer forma — é ele o fecho —, mas a varredura que
       * insiste encheria a fila de linhas nascidas mortas e o painel de entregas do
       * cliente com centenas de `TENANT_INACTIVE` por dia. Pular aqui é o que mantém o
       * bloqueio do despacho no tamanho do que ele existe para apanhar: a mensagem que
       * já estava na fila quando a conta parou.
       */
      if (!(await tenantOperational(tenantId))) continue

      const context = await withTenant(tenantId, async (tx) => {
        const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
        return {
          timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
          automation: await resolveAutomation(tx, key),
        }
      })

      if (!context.automation.enabled) continue

      const sendHour = Number(context.automation.config.sendHour ?? 9)
      if (localHour(now, context.timezone) !== sendHour) continue

      summary.tenants += 1
      await handler(
        {
          tenantId,
          timezone: context.timezone,
          today: todayIn(context.timezone, now),
          automation: context.automation,
        },
        summary,
      )
    } catch (error) {
      logger.error({ err: error, tenantId, key }, 'falha na varredura diária do tenant')
    }
  }

  return summary
}
