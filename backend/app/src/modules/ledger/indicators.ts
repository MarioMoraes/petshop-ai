import { withTenant } from '@petshop/db'
import type { FinanceIndicators } from '@petshop/shared-types'

interface CollectionRow {
  weighted: number | null
  settled: bigint | null
}

interface PackagesRow {
  with_active: bigint
  active_tutors: bigint
}

interface ExpiredRow {
  purchases: bigint
  credits: bigint
  value: bigint
}

/**
 * Os indicadores do financeiro que o PRD financeiro_tutor_05 §10 nomeia e que os
 * relatórios de cobrança não respondem — a faixa "Financeiro" do Início.
 *
 * **Prazo médio de recebimento** sai das alocações, e não dos pagamentos: é a alocação
 * que diz qual débito cada real quitou. O prazo de cada uma é do fato gerador
 * (`occurred_at`) ao `received_at` do pagamento, ponderado pelo valor alocado. Duas
 * decisões moram aqui:
 *
 * - pagamento **antes** do serviço conta como zero dia, e não como prazo negativo. O
 *   crédito deixado no balcão e consumido depois é o melhor caso possível, e um número
 *   negativo o faria compensar o atraso de outro tutor na média;
 * - `PACKAGE_CREDIT` fica de fora. Resgate de pacote não é dinheiro entrando: o dinheiro
 *   entrou na compra, e contá-lo de novo no resgate derrubaria o prazo sem ninguém ter
 *   pago nada mais cedo.
 *
 * **Adesão a pacotes** divide por tutores ativos contados na mesma consulta. Ler
 * `tutors` a partir do financeiro tem precedente — o `messaging` lê `tutor_consents`
 * direto —, e é o que mantém numerador e denominador no mesmo instante.
 *
 * **Crédito vencido sem uso** conta a compra cujo prazo acabou dentro do período,
 * esteja ela já marcada `EXPIRED` ou ainda `ACTIVE` à espera do job diário: o crédito
 * está perdido no instante do `expires_at` (RN-08), e não quando o job passa. O valor é
 * a fração não usada do que o tutor **pagou** — o lançamento da compra, e não o preço de
 * catálogo, que pode ter mudado ou ter sido sobrescrito na venda.
 */
export async function financeIndicators(
  tenantId: string,
  days: number,
  now: Date = new Date(),
): Promise<FinanceIndicators> {
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  return withTenant(tenantId, async (tx) => {
    const [collection, packages, expired] = await Promise.all([
      tx.$queryRaw<CollectionRow[]>`
        SELECT SUM(
                 a.amount_cents
                 * GREATEST(0, EXTRACT(EPOCH FROM (p.received_at - e.occurred_at)) / 86400)
               )::float8 AS weighted,
               SUM(a.amount_cents)::bigint AS settled
          FROM payment_allocations a
          JOIN payments p ON p.id = a.payment_id
          JOIN ledger_entries e ON e.id = a.debit_entry_id
         WHERE a.tenant_id = ${tenantId}::uuid
           AND a.reversed_at IS NULL
           AND p.status = 'RECORDED'
           AND p.method <> 'PACKAGE_CREDIT'
           AND e.status = 'POSTED'
           AND p.received_at >= ${from}
           AND p.received_at < ${to}
      `,
      tx.$queryRaw<PackagesRow[]>`
        SELECT COUNT(*) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM package_purchases pp
                    WHERE pp.tutor_id = t.id
                      AND pp.status = 'ACTIVE'
                      AND pp.expires_at > ${to}
                 )
               ) AS with_active,
               COUNT(*) AS active_tutors
          FROM tutors t
         WHERE t.tenant_id = ${tenantId}::uuid
           AND t.status = 'ACTIVE'
      `,
      tx.$queryRaw<ExpiredRow[]>`
        SELECT COUNT(*) AS purchases,
               COALESCE(SUM(pp.credits_total - pp.credits_used), 0)::bigint AS credits,
               COALESCE(
                 SUM(ROUND(e.amount_cents::numeric * (pp.credits_total - pp.credits_used)
                           / pp.credits_total)),
                 0
               )::bigint AS value
          FROM package_purchases pp
          JOIN ledger_entries e ON e.id = pp.entry_id
         WHERE pp.tenant_id = ${tenantId}::uuid
           AND pp.status IN ('ACTIVE', 'EXPIRED')
           AND pp.credits_total > 0
           AND pp.credits_used < pp.credits_total
           AND pp.expires_at >= ${from}
           AND pp.expires_at < ${to}
      `,
    ])

    const settledCents = Number(collection[0]?.settled ?? 0)
    const weighted = collection[0]?.weighted ?? 0

    return {
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      collection: {
        averageDays: settledCents > 0 ? weighted / settledCents : null,
        settledCents,
      },
      packages: {
        tutorsWithActive: Number(packages[0]?.with_active ?? 0),
        activeTutors: Number(packages[0]?.active_tutors ?? 0),
      },
      expired: {
        purchases: Number(expired[0]?.purchases ?? 0),
        credits: Number(expired[0]?.credits ?? 0),
        valueCents: Number(expired[0]?.value ?? 0),
      },
    }
  })
}
