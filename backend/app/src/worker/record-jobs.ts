import type { JobDefinition } from '@petshop/job-scheduler'
import { retryPendingPrescriptions } from '../modules/prescriptions/service.js'

/**
 * A grade do prontuário.
 *
 * Um job só: o reprocesso de documento (MOD-DOC-11). De dez em dez minutos, e não de
 * madrugada, pelo mesmo motivo do recibo e do termo — um receituário que não saiu é um
 * tutor na porta da farmácia agora, não amanhã.
 *
 * **O nome é o mesmo de quando isto era serviço.** O lease é por nome, e renomear faria
 * réplicas velhas e novas rodarem o mesmo job em paralelo durante o deploy.
 */

export const recordJobs: JobDefinition[] = [
  {
    name: 'record.retry-prescriptions',
    schedule: '*/10 * * * *',
    timeoutMs: 5 * 60_000,
    run: (now) => retryPendingPrescriptions(now),
  },
]
