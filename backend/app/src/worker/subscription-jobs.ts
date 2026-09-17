import type { JobDefinition } from '@petshop/job-scheduler'
import { runSuspendOverdueOnce } from '../modules/subscription/overdue.js'

/**
 * A grade da assinatura (camada comercial, fatia 4).
 *
 * De hora em hora, pela mesma razão do fim do teste: a varredura **é** a suspensão, e a
 * carência que vence às 10h não pode seguir gravando até a madrugada.
 */
export const subscriptionJobs: JobDefinition[] = [
  {
    name: 'subscription.suspend-overdue',
    schedule: '50 * * * *',
    timeoutMs: 120_000,
    run: (now) => runSuspendOverdueOnce(now).then(() => undefined),
  },
]
