import { getMaintenancePrisma } from '@petshop/db'
import type { PlatformAlert, PlatformAlertQuery } from '@petshop/shared-types'
import { publishEvent } from '../../shared/events.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { alertRecipients, getAlertMailer } from './alert-mailer.js'
import { ALERT_RULES, firstFive, ruleByKey, type AlertBreach, type AlertRule } from './alert-rules.js'

/**
 * O motor de alertas (MOD-ADMIN-06).
 *
 * Três decisões governam este arquivo:
 *
 * 1. **Duas avaliações para acender, duas para apagar** (AC-01 e AC-03). Um pico de um
 *    minuto na fila não é incidente; o que interessa é a condição que **permanece**. E
 *    alerta que só acende, sem nunca dizer que passou, treina a equipe a ignorar o painel.
 * 2. **O contador mora no banco.** Em memória ele zeraria a cada deploy, e com réplicas
 *    revezando o lease do job nunca chegaria a dois — a regra jamais dispararia num
 *    ambiente com mais de uma réplica, e o defeito seria invisível em desenvolvimento.
 * 3. **Uma notificação por regra, por avaliação** (AC-04). Trinta estabelecimentos com a
 *    fila presa no mesmo minuto são um incidente, não trinta; o e-mail leva a contagem e
 *    os cinco primeiros. O agrupamento por regra é o que a janela de cinco minutos do PRD
 *    descreve, e aqui ela é o próprio intervalo do job.
 */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/** Quantas avaliações seguidas a condição precisa valer — e deixar de valer. */
const STREAK_TO_FIRE = 2
const STREAK_TO_RESOLVE = 2

interface OpenAlert {
  id: string
  rule: string
  tenantId: string | null
  status: 'PENDING' | 'FIRING'
  breachStreak: number
  clearStreak: number
}

export interface EvaluationResult {
  fired: number
  resolved: number
  pending: number
}

export async function evaluateAlerts(now: Date = new Date()): Promise<EvaluationResult> {
  const resultado: EvaluationResult = { fired: 0, resolved: 0, pending: 0 }

  for (const rule of ALERT_RULES) {
    try {
      const parcial = await evaluateRule(rule, now)
      resultado.fired += parcial.fired
      resultado.resolved += parcial.resolved
      resultado.pending += parcial.pending
    } catch (error) {
      /**
       * Uma regra que falha não pode calar as outras.
       *
       * É o oposto do que parece prudente: abortar a avaliação inteira ao primeiro erro
       * deixaria a fila presa sem alarme porque a sonda do Gotenberg deu timeout.
       */
      logger.error({ err: error, rule: rule.key }, 'falha ao avaliar regra de alerta')
    }
  }

  return resultado
}

async function evaluateRule(rule: AlertRule, now: Date): Promise<EvaluationResult> {
  const prisma = getMaintenancePrisma()
  const breaches = await rule.evaluate(now)
  const porChave = new Map(breaches.map((breach) => [breach.tenantId ?? ZERO_UUID, breach]))

  const abertos = (await prisma.platformAlert.findMany({
    where: { rule: rule.key, status: { in: ['PENDING', 'FIRING'] } },
    select: {
      id: true,
      rule: true,
      tenantId: true,
      status: true,
      breachStreak: true,
      clearStreak: true,
    },
  })) as OpenAlert[]

  const abertosPorChave = new Map(abertos.map((row) => [row.tenantId ?? ZERO_UUID, row]))

  const acenderam: AlertBreach[] = []
  const apagaram: OpenAlert[] = []
  let pendentes = 0

  // ── A condição vale ───────────────────────────────────────────────────────
  for (const [chave, breach] of porChave) {
    const aberto = abertosPorChave.get(chave)

    if (!aberto) {
      await prisma.platformAlert.create({
        data: {
          rule: rule.key,
          tenantId: breach.tenantId,
          status: 'PENDING',
          value: breach.value,
          breachStreak: 1,
          clearStreak: 0,
          firstSeenAt: now,
          lastEvaluatedAt: now,
        },
      })
      pendentes += 1
      continue
    }

    const streak = aberto.breachStreak + 1
    const acende = aberto.status === 'PENDING' && streak >= STREAK_TO_FIRE

    await prisma.platformAlert.update({
      where: { id: aberto.id },
      data: {
        value: breach.value,
        breachStreak: streak,
        clearStreak: 0,
        lastEvaluatedAt: now,
        ...(acende ? { status: 'FIRING' as const, firedAt: now } : {}),
      },
    })

    if (acende) acenderam.push(breach)
    else if (aberto.status === 'PENDING') pendentes += 1
  }

  // ── A condição não vale mais ──────────────────────────────────────────────
  for (const aberto of abertos) {
    if (porChave.has(aberto.tenantId ?? ZERO_UUID)) continue

    /**
     * O que nunca acendeu, some sem deixar rastro.
     *
     * Guardar como `RESOLVED` um alerta que jamais disparou encheria o histórico de
     * incidentes que não existiram — e o §6 do PRD é explícito: condição que não vale, nada
     * acontece.
     */
    if (aberto.status === 'PENDING') {
      await prisma.platformAlert.delete({ where: { id: aberto.id } })
      continue
    }

    const streak = aberto.clearStreak + 1
    const apaga = streak >= STREAK_TO_RESOLVE

    await prisma.platformAlert.update({
      where: { id: aberto.id },
      data: {
        clearStreak: streak,
        breachStreak: 0,
        lastEvaluatedAt: now,
        ...(apaga ? { status: 'RESOLVED' as const, resolvedAt: now } : {}),
      },
    })

    if (apaga) apagaram.push(aberto)
  }

  if (acenderam.length > 0) await notifyFired(rule, acenderam, now)
  if (apagaram.length > 0) await notifyResolved(rule, apagaram.length)

  return { fired: acenderam.length, resolved: apagaram.length, pending: pendentes }
}

/**
 * Um e-mail por regra, com a contagem e os cinco primeiros (AC-04).
 *
 * O nome do estabelecimento entra no lugar do id: quem lê o alarme às duas da manhã
 * precisa saber de quem se fala sem abrir o painel para traduzir UUID.
 */
async function notifyFired(rule: AlertRule, breaches: AlertBreach[], now: Date): Promise<void> {
  recordMetric({ metric: 'platform_alert_firing_total', value: breaches.length, unit: 'count' })

  for (const breach of breaches) {
    await publishEvent('plataforma.alerta.disparado', {
      rule: rule.key,
      tenantId: breach.tenantId,
      value: breach.value,
      firedAt: now.toISOString(),
    })
  }

  const nomes = await tenantNames(breaches)
  const detalhe = breaches.find((breach) => breach.detail)?.detail
  const total = breaches.reduce((soma, breach) => soma + breach.value, 0)

  const lines = [
    rule.label,
    '',
    breaches.length === 1
      ? `1 alerta, valor ${breaches[0]?.value ?? 0}.`
      : `${breaches.length} alertas ao mesmo tempo, somando ${total}.`,
    ...(nomes.length > 0 ? [`Estabelecimentos: ${firstFive(nomes)}.`] : []),
    ...(detalhe ? [`Detalhe: ${detalhe}.`] : []),
    '',
    rule.action,
  ]

  await getAlertMailer().sendAlert(
    { subject: `[PetShop AI] ${rule.label}`, lines },
    await alertRecipients(),
  )
}

async function notifyResolved(rule: AlertRule, quantidade: number): Promise<void> {
  await getAlertMailer().sendAlert(
    {
      subject: `[PetShop AI] Resolvido: ${rule.label}`,
      lines: [
        `A condição deixou de valer em ${quantidade === 1 ? '1 alerta' : `${quantidade} alertas`}.`,
        '',
        'Nenhuma ação necessária — este aviso existe para que o alarme tenha fim, e não só começo.',
      ],
    },
    await alertRecipients(),
  )
}

async function tenantNames(breaches: AlertBreach[]): Promise<string[]> {
  const ids = breaches
    .map((breach) => breach.tenantId)
    .filter((id): id is string => id !== null)
  if (ids.length === 0) return []

  const rows = await getMaintenancePrisma().tenant.findMany({
    where: { id: { in: ids } },
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((row) => row.name)
}

/** Os alertas, para a rota do painel. */
export async function listAlerts(query: PlatformAlertQuery): Promise<PlatformAlert[]> {
  const rows = await getMaintenancePrisma().platformAlert.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.rule ? { rule: query.rule } : {}),
    },
    orderBy: [{ status: 'asc' }, { firstSeenAt: 'desc' }],
    take: query.limit,
  })

  const tenantIds = rows
    .map((row) => row.tenantId)
    .filter((id): id is string => id !== null)

  const tenants = new Map(
    tenantIds.length === 0
      ? []
      : (
          await getMaintenancePrisma().tenant.findMany({
            where: { id: { in: [...new Set(tenantIds)] } },
            select: { id: true, slug: true, name: true },
          })
        ).map((tenant) => [tenant.id, tenant]),
  )

  return rows.map((row) => ({
    id: row.id,
    rule: row.rule,
    ruleLabel: ruleByKey(row.rule)?.label ?? row.rule,
    status: row.status,
    value: Number(row.value),
    tenant: (row.tenantId ? tenants.get(row.tenantId) : undefined) ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastEvaluatedAt: row.lastEvaluatedAt.toISOString(),
    firedAt: row.firedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }))
}
