import { withTenant, type TenantTransaction } from '@petshop/db'
import { logger } from '../../lib/logger.js'
import { forEachDueTenant, type DailySummary, type TenantRun } from './daily.js'
import { getMessagingPort } from './messaging-port.js'

/**
 * Aniversário de pet e de tutor (MOD-CRM-06).
 *
 * Duas regras deste arquivo não são detalhe de implementação, e vale lê-las antes de
 * mexer em qualquer linha:
 *
 * 1. **Pet falecido nunca recebe.** É o AC-02, e o próprio PRD o chama de "a falha mais
 *    cara que este módulo pode cometer". A seleção já exclui, e o motor **revalida no
 *    despacho** (`dispatch.ts`) — as duas guardas existem porque a janela entre
 *    enfileirar e enviar é real: a mensagem pode passar o dia represada pelo teto diário
 *    enquanto o tutor comunica o óbito no balcão.
 * 2. **29 de fevereiro sai em 28/02** nos anos comuns. É regra explícita, e não acidente
 *    de comparação de datas — o AC-04 pede exatamente isso, e a alternativa silenciosa
 *    seria o cão nascido no bissexto nunca ser parabenizado.
 */

interface BirthdayRow {
  id: string
  name: string
  tutor_id: string
}

/**
 * O par (mês, dia) que hoje representa.
 *
 * Em 28 de fevereiro de um ano comum, representa **dois**: o próprio 28 e o 29 que não
 * existe neste ano. É aqui, e em nenhum outro lugar, que o AC-04 vive.
 */
export function birthdayKeys(today: string): { month: number; day: number }[] {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  const keys = [{ month, day }]

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  if (month === 2 && day === 28 && !isLeap) keys.push({ month: 2, day: 29 })

  return keys
}

export async function sendBirthdays(now: Date = new Date()): Promise<{
  pets: DailySummary
  tutors: DailySummary
}> {
  const pets = await forEachDueTenant('birthday_pet', now, petsOfTenant)
  const tutors = await forEachDueTenant('birthday_tutor', now, tutorsOfTenant)

  if (pets.enqueued > 0 || tutors.enqueued > 0) {
    logger.info({ pets, tutors }, 'felicitações de aniversário enfileiradas')
  }
  return { pets, tutors }
}

async function petsOfTenant(run: TenantRun, summary: DailySummary): Promise<void> {
  const includeEstimated = run.automation.config.includeEstimated === true

  const rows = await withTenant(run.tenantId, (tx) =>
    findPetsBornToday(tx, run.today, includeEstimated),
  )
  summary.scanned += rows.length

  const port = getMessagingPort()
  for (const pet of rows) {
    const ok = await port.enqueue({
      tenantId: run.tenantId,
      tutorId: pet.tutor_id,
      petId: pet.id,
      templateKey: run.automation.templateKey,
      channel: run.automation.channel,
      // A chave é o pet e o **dia civil do tenant**, não a hora da varredura: duas
      // passadas no mesmo dia produzem a mesma chave, e a segunda não cria nada.
      dedupeKey: `birthday_pet:${pet.id}:${run.today}`,
      originType: 'PET',
      originId: pet.id,
      variables: { 'pet.nome': pet.name },
    })

    if (ok) summary.enqueued += 1
    else summary.skipped += 1
  }
}

/**
 * Quem faz aniversário hoje, com o dono principal junto.
 *
 * SQL cru porque a pergunta é sobre **mês e dia**, e o Prisma não sabe escrever
 * `EXTRACT` — é a mesma expressão do índice `idx_pets_birthday`, criado em 2026-08-23
 * justamente para esta consulta e sem nenhum leitor até agora.
 *
 * `role = 'PRIMARY'` decide o destinatário: um pet com dois donos gera **uma** mensagem,
 * para quem responde por ele. Mandar para os dois transforma a felicitação em duas
 * notificações sobre o mesmo cachorro, que é o que a RN-08 combate no curto prazo e
 * ninguém combateria aqui. `unlinked_at IS NULL` porque o vínculo desfeito continua na
 * tabela — é ele que guarda a história da transferência de titularidade do MOD-PET-05.
 */
async function findPetsBornToday(
  tx: TenantTransaction,
  today: string,
  includeEstimated: boolean,
): Promise<BirthdayRow[]> {
  const keys = birthdayKeys(today)
  const months = keys.map((key) => key.month)
  const days = keys.map((key) => key.day)

  return tx.$queryRaw<BirthdayRow[]>`
    SELECT p.id, p.name, pt.tutor_id
      FROM pets p
      JOIN pet_tutors pt ON pt.pet_id = p.id
                        AND pt.role = 'PRIMARY'
                        AND pt.unlinked_at IS NULL
     WHERE p.status = 'ACTIVE'
       AND p.deleted_at IS NULL
       AND p.birth_date IS NOT NULL
       AND (EXTRACT(MONTH FROM p.birth_date), EXTRACT(DAY FROM p.birth_date))
           IN (SELECT * FROM unnest(${months}::int[], ${days}::int[]))
       AND (${includeEstimated} OR p.birth_date_precision = 'EXACT')
     LIMIT 500
  `
}

async function tutorsOfTenant(run: TenantRun, summary: DailySummary): Promise<void> {
  const keys = birthdayKeys(run.today)
  const months = keys.map((key) => key.month)
  const days = keys.map((key) => key.day)

  const rows = await withTenant(run.tenantId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tutors
       WHERE status = 'ACTIVE'
         AND deleted_at IS NULL
         AND birth_date IS NOT NULL
         AND (EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date))
             IN (SELECT * FROM unnest(${months}::int[], ${days}::int[]))
       LIMIT 500
    `,
  )
  summary.scanned += rows.length

  const port = getMessagingPort()
  for (const tutor of rows) {
    const ok = await port.enqueue({
      tenantId: run.tenantId,
      tutorId: tutor.id,
      templateKey: run.automation.templateKey,
      channel: run.automation.channel,
      dedupeKey: `birthday_tutor:${tutor.id}:${run.today}`,
      // O texto não cita os pets — ver o comentário do template `birthday_tutor`. Um
      // tutor sem pet vivo receberia a frase com um buraco no meio, no dia do
      // aniversário dele.
      variables: {},
    })

    if (ok) summary.enqueued += 1
    else summary.skipped += 1
  }
}
