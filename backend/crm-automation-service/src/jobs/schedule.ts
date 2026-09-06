import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import { sendBirthdays } from '../modules/crm/birthdays.js'
import { runScheduledCampaigns } from '../modules/crm/campaigns.js'
import { runDunning } from '../modules/crm/dunning.js'
import { runInactiveCampaign } from '../modules/crm/inactive.js'
import { sendAppointmentReminders } from '../modules/crm/reminders.js'

/**
 * A grade do relacionamento.
 *
 * Duas famílias de job, com relógios diferentes pelo mesmo motivo — o fuso do
 * estabelecimento.
 *
 * O **lembrete** é a rede de proteção do módulo: a varredura que garante o aviso mesmo
 * quando o evento se perde. De hora em hora, casado com a largura da janela de busca em
 * `reminders.ts` — mudar um sem o outro abre um buraco por onde agendamentos passam sem
 * lembrete.
 *
 * As **três da fatia 3** são diárias por natureza, mas rodam de hora em hora e cada
 * tenant só age quando o relógio dele marca a hora configurada (ver `daily.ts`). Um cron
 * diário em UTC mandaria a felicitação às cinco da manhã para quem está em Rio Branco.
 *
 * Os minutos são escalonados de propósito. As quatro varreduras leem as mesmas tabelas, e
 * largá-las no mesmo instante faria quatro picos simultâneos de hora em hora — sem ganho
 * nenhum, porque nada aqui depende de nada.
 */

export const { startJobs, stopJobs, runJobNow } = createJobScheduler({
  service: 'crm-automation-service',
  logger,
  recordMetric,
  isDisabled: () => loadEnv().DISABLE_JOBS,
  jobs: [
    {
      name: 'crm.appointment-reminders',
      schedule: '5 * * * *',
      run: (now) => sendAppointmentReminders(now),
    },
    {
      name: 'crm.birthdays',
      schedule: '15 * * * *',
      run: (now) => sendBirthdays(now),
    },
    {
      name: 'crm.dunning',
      schedule: '25 * * * *',
      run: (now) => runDunning(now),
    },
    {
      name: 'crm.inactive-campaign',
      schedule: '35 * * * *',
      run: (now) => runInactiveCampaign(now),
    },
    {
      // A campanha agendada não olha o fuso: quem marcou a data escolheu um instante, e
      // o instante é o mesmo em qualquer relógio. De quinze em quinze minutos, para o
      // atraso máximo entre a hora marcada e o disparo ser um quarto de hora.
      name: 'crm.scheduled-campaigns',
      schedule: '*/15 * * * *',
      run: (now) => runScheduledCampaigns(now),
    },
  ],
})
