import { createJobScheduler } from '@petshop/job-scheduler'
import { loadEnv } from '../env.js'
import { logger, recordMetric } from '../lib/logger.js'
import { sendAppointmentReminders } from '../modules/crm/reminders.js'

/**
 * A grade do relacionamento.
 *
 * Um job só, na fatia 1, e ele é a rede de proteção do módulo inteiro: a varredura que
 * garante o lembrete mesmo quando o evento se perde. De hora em hora, casado com a
 * largura da janela de busca em `reminders.ts` — mudar um sem o outro abre um buraco
 * por onde agendamentos passam sem lembrete.
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
  ],
})
