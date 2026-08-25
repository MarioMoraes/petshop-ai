import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import { runProvisioningRetryOnce } from '../modules/tenants/provisioning-retry.js'

/**
 * A grade da identidade.
 *
 * Um job só, e ele existe porque o provisionamento fala com o Clerk: uma indisponilidade
 * de dois minutos lá deixa um tenant preso em `PROVISIONING` aqui, e sem esta varredura
 * o dono do petshop ficaria olhando uma tela de "criando seu estabelecimento" para
 * sempre.
 *
 * De dois em dois minutos porque é o tempo que alguém espera olhando a tela antes de
 * fechar a aba — não de madrugada, como os do financeiro.
 */

export const { startJobs, stopJobs, runJobNow } = createJobScheduler({
  service: 'identity-service',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    {
      name: 'identity.provisioning-retry',
      schedule: '*/2 * * * *',
      timeoutMs: 90_000,
      run: () => runProvisioningRetryOnce(),
    },
  ],
})
