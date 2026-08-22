import { listTenantsPendingProvisioning } from '@petshop/db'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'
import { finalizeProvisioning } from './service.js'

/**
 * Job `tenant-provisioning-retry` (AC-03 de MOD-IDENT-01).
 *
 * Roda a cada 2 minutos e retoma os tenants presos em `PROVISIONING`. A varredura é
 * cross-tenant, então usa `app_maintenance` — que é exatamente o caso em que o PRD
 * autoriza a role com BYPASSRLS. O trabalho por tenant, esse sim, volta a passar por
 * `withTenant`.
 *
 * `finalizeProvisioning` é idempotente: reencontra a Organization pelo slug em vez de
 * criar uma segunda, e conta a tentativa a cada falha até `PROVISIONING_FAILED`.
 */

let timer: NodeJS.Timeout | null = null
let running = false

export async function runProvisioningRetryOnce(): Promise<{ processed: number }> {
  if (running) return { processed: 0 }
  running = true

  try {
    const pending = await listTenantsPendingProvisioning(loadEnv().PROVISIONING_MAX_ATTEMPTS)
    if (pending.length === 0) return { processed: 0 }

    logger.info({ count: pending.length }, 'retomando provisionamentos pendentes')

    for (const tenant of pending) {
      try {
        await finalizeProvisioning(tenant.id)
      } catch (error) {
        // finalizeProvisioning já contabiliza a falha do Clerk; cair aqui significa
        // erro inesperado, que não pode interromper a fila.
        logger.error({ err: error, tenantId: tenant.id }, 'erro inesperado no retry')
      }
    }

    return { processed: pending.length }
  } finally {
    running = false
  }
}

export function startProvisioningRetry(): void {
  if (timer) return
  const intervalMs = loadEnv().PROVISIONING_RETRY_INTERVAL_MS
  timer = setInterval(() => {
    void runProvisioningRetryOnce()
  }, intervalMs)
  timer.unref()
  logger.info({ intervalMs }, 'job tenant-provisioning-retry iniciado')
}

export function stopProvisioningRetry(): void {
  if (timer) clearInterval(timer)
  timer = null
}
