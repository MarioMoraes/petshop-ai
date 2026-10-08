import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import { addDays } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { forEachDueTenant, type DailySummary, type TenantRun } from './daily.js'
import { getMessagingPort } from './messaging-port.js'

/**
 * O lembrete da próxima dose (MOD-PRONT-08, AC-01).
 *
 * Varredura diária sobre `vaccinations.next_dose_at`, e não consumidor de
 * `vacina.aplicada`: um evento perdido seria uma vacina vencida sem ninguém saber, que é
 * o mesmo argumento do lembrete de agendamento (`reminders.ts`).
 *
 * Três decisões que o arquivo guarda:
 *
 * 1. **A janela é de amanhã até `daysBefore`, e não um dia só.** Uma passada perdida (o
 *    processo fora do ar às nove) ou uma dose lançada já perto do vencimento não pode
 *    ficar sem aviso. Quem garante um aviso só é o `dedupeKey`, que é a dose.
 * 2. **Só a dose vigente lembra.** A V10 de 2025 superada pela de 2026 não fala mais
 *    nada — a escolha é a mesma `currentDoses` da carteira, escrita em SQL
 *    (`DISTINCT ON` pelo mesmo grupo de `vaccineGroupKey`).
 * 3. **Todo plano.** A automação não é campanha; o WhatsApp segue sendo do Pro pelo
 *    canal, como em todo o resto.
 */

interface DueDose {
  id: string
  pet_id: string
  pet_name: string
  tutor_id: string
  vaccine_label: string
  next_dose_at: Date
}

export async function sendVaccineReminders(now: Date = new Date()): Promise<DailySummary> {
  const summary = await forEachDueTenant('vaccine_reminder', now, remindTenant, () =>
    discoverTenants(now),
  )
  if (summary.enqueued > 0) logger.info(summary, 'lembretes de vacina enfileirados')
  return summary
}

/**
 * Os tenants com alguma dose viva vencendo no próximo mês. A margem é larga de
 * propósito: o recorte fino (fuso e `daysBefore`) é feito por tenant, e aqui só se evita
 * abrir transação em quem não tem vacina nenhuma por vencer.
 */
function discoverTenants(now: Date): Promise<{ tenant_id: string }[]> {
  const day = now.toISOString().slice(0, 10)
  return getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM vaccinations
     WHERE voided_at IS NULL
       AND next_dose_at BETWEEN ${addDays(day, -1)}::date AND ${addDays(day, 32)}::date
  `
}

async function remindTenant(run: TenantRun, summary: DailySummary): Promise<void> {
  const daysBefore = Number(run.automation.config.daysBefore ?? 7)
  const from = addDays(run.today, 1)
  const to = addDays(run.today, daysBefore)

  const doses = await withTenant(run.tenantId, (tx) => findDueDoses(tx, from, to))
  summary.scanned += doses.length

  const port = getMessagingPort()
  for (const dose of doses) {
    const ok = await port.enqueue({
      tenantId: run.tenantId,
      tutorId: dose.tutor_id,
      petId: dose.pet_id,
      templateKey: run.automation.templateKey,
      channel: run.automation.channel,
      // A dose, e não o dia: a janela devolve a mesma dose por vários dias seguidos.
      dedupeKey: `vaccine_due:${dose.id}`,
      originType: 'PET',
      originId: dose.pet_id,
      variables: {
        'pet.nome': dose.pet_name,
        'vacina.nome': dose.vaccine_label,
        'vacina.data': dose.next_dose_at.toISOString().slice(0, 10).split('-').reverse().join('/'),
      },
    })

    if (ok) summary.enqueued += 1
    else summary.skipped += 1
  }
}

/**
 * A dose vigente de cada vacina com a próxima dose na janela, e o dono principal.
 *
 * O grupo do `DISTINCT ON` é a expressão de `vaccineGroupKey` (shared-types): a chave do
 * catálogo, ou o nome em "Outra". O filtro de dentro (`pet_id IN …`) usa o índice parcial
 * `idx_vaccinations_next_dose` para não montar a carteira de todos os pets do tenant.
 * `role = 'PRIMARY'` pelo mesmo motivo do aniversário: um pet, uma mensagem.
 */
function findDueDoses(tx: TenantTransaction, from: string, to: string): Promise<DueDose[]> {
  return tx.$queryRaw<DueDose[]>`
    SELECT cur.id, cur.pet_id, p.name AS pet_name, pt.tutor_id, cur.vaccine_label, cur.next_dose_at
      FROM (
        SELECT DISTINCT ON (
                 v.pet_id,
                 CASE WHEN v.vaccine_key = 'OTHER'
                      THEN 'OTHER:' || lower(btrim(v.vaccine_label))
                      ELSE v.vaccine_key END
               )
               v.id, v.pet_id, v.vaccine_label, v.next_dose_at
          FROM vaccinations v
         WHERE v.voided_at IS NULL
           AND v.pet_id IN (
             SELECT pet_id FROM vaccinations
              WHERE voided_at IS NULL
                AND next_dose_at BETWEEN ${from}::date AND ${to}::date
           )
         ORDER BY v.pet_id,
                  CASE WHEN v.vaccine_key = 'OTHER'
                       THEN 'OTHER:' || lower(btrim(v.vaccine_label))
                       ELSE v.vaccine_key END,
                  v.applied_at DESC,
                  v.created_at DESC
      ) cur
      JOIN pets p ON p.id = cur.pet_id
                 AND p.status = 'ACTIVE'
                 AND p.deleted_at IS NULL
      JOIN pet_tutors pt ON pt.pet_id = cur.pet_id
                        AND pt.role = 'PRIMARY'
                        AND pt.unlinked_at IS NULL
     WHERE cur.next_dose_at BETWEEN ${from}::date AND ${to}::date
     LIMIT 500
  `
}
