import type { JobDefinition } from '@petshop/job-scheduler'
import { retryPendingTermDocuments } from '../modules/terms/acceptance.js'

/**
 * A grade do cadastro.
 *
 * Um job só: o reprocesso de documento (MOD-DOC-11). De dez em dez minutos, e não de
 * madrugada, pelo mesmo motivo do recibo e do receituário — um termo que não saiu é um
 * tutor no balcão esperando o papel agora, não amanhã.
 */

export const tutorJobs: JobDefinition[] = [
  {
    name: 'tutor.retry-term-documents',
    schedule: '*/10 * * * *',
    timeoutMs: 5 * 60_000,
    run: (now) => retryPendingTermDocuments(now),
  },
  
]
