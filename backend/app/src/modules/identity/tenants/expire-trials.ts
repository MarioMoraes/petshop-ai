import { getMaintenancePrisma } from '@petshop/db'
import { logger } from '../../../shared/logger.js'
import { transitionTenantStatus } from '../../../shared/tenant-status.js'

/**
 * Camada comercial, fatia 3 — o teste que vence sem assinatura.
 *
 * O estabelecimento vai a `TRIAL_EXPIRED`: continua entrando e lendo tudo o que registrou,
 * e deixa de gravar até assinar (decisão do produto de 2026-09-17). Site e Portal saem do
 * ar para os clientes, pela mesma regra que já valia para o suspenso.
 *
 * **Diferente da expiração de convites, aqui o job é o que faz a coisa acontecer.** A
 * sessão lê o estado, e não a data: conferir `trial_ends_at` a cada requisição poria uma
 * segunda fonte de verdade no caminho quente. O preço é a hora de folga entre o vencimento
 * e a varredura, que é generosa com o cliente e não com a plataforma — o lado certo.
 *
 * Cross-tenant por natureza, pela role `app_maintenance`. Lote de 200 por rodada: um
 * acúmulo depois de o worker ficar parado escoa em poucas horas sem uma rodada longa.
 */
export async function runExpireTrialsOnce(now: Date = new Date()): Promise<number> {
  const vencidos = await getMaintenancePrisma().tenant.findMany({
    where: { status: 'TRIAL', trialEndsAt: { lte: now }, deletedAt: null },
    select: { id: true },
    orderBy: { trialEndsAt: 'asc' },
    take: 200,
  })

  let expired = 0
  for (const { id } of vencidos) {
    try {
      const changed = await transitionTenantStatus(id, {
        from: ['TRIAL'],
        to: 'TRIAL_EXPIRED',
        reason: 'TRIAL_EXPIRED',
      })
      if (changed) expired += 1
    } catch (error) {
      // Um estabelecimento que falha não segura os outros: a rodada seguinte o reencontra.
      logger.error({ err: error, tenantId: id }, 'falha ao encerrar o período de teste')
    }
  }

  if (expired > 0) logger.info({ expired }, 'períodos de teste encerrados')
  return expired
}
