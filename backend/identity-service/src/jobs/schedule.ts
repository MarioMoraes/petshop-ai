import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import { runExpireInvitationsOnce } from '../modules/invitations/expire.js'
import { runProvisioningRetryOnce } from '../modules/tenants/provisioning-retry.js'

/**
 * A grade da identidade.
 *
 * Dois jobs, em cadências que dizem para quem cada um trabalha.
 *
 * O retry de provisionamento existe porque o provisionamento fala com o Clerk: uma
 * indisponibilidade de dois minutos lá deixa um tenant preso em `PROVISIONING` aqui, e
 * sem esta varredura o dono do petshop ficaria olhando uma tela de "criando seu
 * estabelecimento" para sempre. De dois em dois minutos porque é o tempo que alguém
 * espera olhando a tela antes de fechar a aba.
 *
 * A expiração de convites não tem ninguém esperando: o convite vencido já é recusado
 * na hora do uso (`effectiveStatus`), e a varredura só faz o banco concordar com isso
 * para a lista da tela de equipe. De madrugada, como os do financeiro.
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
    {
      name: 'identity.expire-invitations',
      schedule: '20 4 * * *',
      timeoutMs: 60_000,
      run: () => runExpireInvitationsOnce(),
    },
  ],
})
