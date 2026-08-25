import { listTenantsPendingProvisioning } from '@petshop/db'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'
import { finalizeProvisioning } from './service.js'

/**
 * Job `tenant-provisioning-retry` (AC-03 de MOD-IDENT-01).
 *
 * Retoma os tenants presos em `PROVISIONING`. A varredura é cross-tenant, então usa
 * `app_maintenance` — que é exatamente o caso em que o PRD autoriza a role com
 * BYPASSRLS. O trabalho por tenant, esse sim, volta a passar por `withTenant`.
 *
 * `finalizeProvisioning` é idempotente: reencontra a Organization pelo slug em vez de
 * criar uma segunda, e conta a tentativa a cada falha até `PROVISIONING_FAILED`.
 *
 * **Quem chama no relógio é `jobs/schedule.ts`.** Este arquivo teve o próprio
 * `setInterval` até a chegada do `@petshop/job-scheduler`; manter dois mecanismos de
 * agendamento seria garantir que divergissem — e só um deles impede duas réplicas de
 * provisionar o mesmo tenant ao mesmo tempo.
 */

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

