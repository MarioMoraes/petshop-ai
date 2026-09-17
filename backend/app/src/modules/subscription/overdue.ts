import { getMaintenancePrisma } from '@petshop/db'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { transitionTenantStatus } from '../../shared/tenant-status.js'

/**
 * A carência que vence (camada comercial, fatia 4).
 *
 * Mensalidade em atraso **não** bloqueia na hora: o estabelecimento fica `PAST_DUE`,
 * trabalha normalmente e vê o aviso no topo. Passados `BILLING_GRACE_DAYS` (7 por
 * padrão), fica só em leitura, como o teste vencido — é a mesma regra, com a mesma
 * frase de saída: pagar.
 *
 * Duas varreduras:
 *
 * - **atraso sem pagamento** além da carência → `SUSPENDED`;
 * - **assinatura cancelada** cujo último mês pago já passou → `SUSPENDED`. Sem esta, quem
 *   cancelasse no Asaas continuaria `ACTIVE` para sempre, porque nenhuma cobrança nova
 *   nasceria para vencer.
 */

const MES_PAGO_MS = 31 * 24 * 60 * 60 * 1000
const DIA_MS = 24 * 60 * 60 * 1000

export async function runSuspendOverdueOnce(now: Date = new Date()): Promise<number> {
  const carencia = new Date(now.getTime() - loadEnv().BILLING_GRACE_DAYS * DIA_MS)
  const prisma = getMaintenancePrisma()

  const [atrasados, cancelados] = await Promise.all([
    prisma.tenantSubscription.findMany({
      where: { status: 'PAST_DUE', overdueSince: { lte: carencia } },
      select: { tenantId: true },
      take: 200,
    }),
    prisma.tenantSubscription.findMany({
      where: {
        status: 'CANCELED',
        lastPaidAt: { lte: new Date(now.getTime() - MES_PAGO_MS) },
        tenant: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
      },
      select: { tenantId: true },
      take: 200,
    }),
  ])

  let suspended = 0
  const alvos = [
    ...atrasados.map((row) => ({ tenantId: row.tenantId, reason: 'OVERDUE_GRACE_ENDED' })),
    ...cancelados.map((row) => ({ tenantId: row.tenantId, reason: 'SUBSCRIPTION_CANCELED' })),
  ]
  for (const alvo of alvos) {
    try {
      const changed = await transitionTenantStatus(alvo.tenantId, {
        from: ['ACTIVE', 'PAST_DUE'],
        to: 'SUSPENDED',
        reason: alvo.reason,
      })
      if (changed) suspended += 1
    } catch (error) {
      logger.error({ err: error, tenantId: alvo.tenantId }, 'falha ao suspender por atraso')
    }
  }

  if (suspended > 0) logger.info({ suspended }, 'estabelecimentos suspensos por falta de pagamento')
  return suspended
}
