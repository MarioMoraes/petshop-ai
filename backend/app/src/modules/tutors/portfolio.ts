import { withTenant } from '@petshop/db'
import type { PortfolioQuality } from '@petshop/shared-types'

interface CountRow {
  total: bigint
}

/**
 * Qualidade da carteira — os dois números da faixa "Sua base" que o PRD tutores_02 §10
 * nomeia: cadastros completos e opt-in de WhatsApp.
 *
 * Os três totais saem da mesma transação, e não do "Tutores ativos" do cartão ao lado:
 * a porcentagem é razão entre dois números, e os dois precisam ser do mesmo instante.
 *
 * **O opt-in é o de marketing, e é o último registro que vale.** `tutor_consents` é
 * append-only (RN-05) e guarda a história inteira — quem autorizou, revogou e autorizou
 * de novo tem três linhas. A leitura é a mesma de `messaging/consent.ts` e de
 * `crm/segments.ts`: a linha mais recente do canal decide, e só `MARKETING` ou `BOTH`
 * liberam campanha. `TRANSACTIONAL` sozinho recebe o lembrete do banho e não recebe
 * promoção, então não conta no teto de alcance que o número quer mostrar.
 */
export async function portfolioQuality(tenantId: string): Promise<PortfolioQuality> {
  return withTenant(tenantId, async (tx) => {
    const [active, complete, whatsapp] = await Promise.all([
      tx.tutor.count({ where: { status: 'ACTIVE' } }),
      tx.tutor.count({ where: { status: 'ACTIVE', dataCompleteness: 'COMPLETE' } }),
      tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS total
          FROM tutors t
          JOIN LATERAL (
                 SELECT c.granted, c.purpose
                   FROM tutor_consents c
                  WHERE c.tutor_id = t.id
                    AND c.channel = 'WHATSAPP'
                  ORDER BY c.created_at DESC
                  LIMIT 1
               ) ultimo ON true
         WHERE t.tenant_id = ${tenantId}::uuid
           AND t.status = 'ACTIVE'
           AND ultimo.granted
           AND ultimo.purpose IN ('MARKETING', 'BOTH')
      `,
    ])

    return { active, complete, whatsappMarketing: Number(whatsapp[0]?.total ?? 0) }
  })
}
