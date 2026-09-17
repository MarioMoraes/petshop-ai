import type { JobDefinition } from '@petshop/job-scheduler'
import { runExpireInvitationsOnce } from '../modules/identity/invitations/expire.js'
import { runExpireTrialsOnce } from '../modules/identity/tenants/expire-trials.js'
import { runProvisioningRetryOnce } from '../modules/identity/tenants/provisioning-retry.js'

/**
 * A grade da identidade.
 *
 * Três jobs, em cadências que dizem para quem cada um trabalha.
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
 *
 * **Os dois nomes são os mesmos de quando isto era serviço.** O lease é por nome, e
 * renomear aqui faria as réplicas velhas e novas rodarem o mesmo job em paralelo
 * durante o deploy.
 */

export const identityJobs: JobDefinition[] = [
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
  {
    // De hora em hora, e não de madrugada como os convites: aqui a varredura **é** o
    // vencimento, e um teste que termina às 10h não pode seguir gravando até as 4h do dia
    // seguinte. Nome novo — não existia quando isto era serviço.
    name: 'identity.expire-trials',
    schedule: '40 * * * *',
    timeoutMs: 120_000,
    run: (now) => runExpireTrialsOnce(now).then(() => undefined),
  },
]
