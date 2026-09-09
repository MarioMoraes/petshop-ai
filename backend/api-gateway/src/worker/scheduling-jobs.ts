import type { JobDefinition } from '@petshop/job-scheduler'
import {
  expirePendingApprovals,
  extendRecurrences,
  sweepNoShows,
} from '../modules/scheduling/jobs.js'

/**
 * A grade da agenda.
 *
 * Nenhum dos três primeiros é de madrugada, e a razão é a mesma: eles operam sobre o
 * dia que está acontecendo. Marcar as faltas de hoje amanhã de manhã seria descobrir o
 * prejuízo tarde demais para fazer algo com ele.
 *
 * A exceção é a recorrência, que empurra um horizonte de doze semanas — essa sim pode
 * esperar o domingo de madrugada.
 *
 * **Os nomes são os mesmos de quando isto era serviço.** O lease é por nome, e renomear
 * faria réplicas velhas e novas rodarem o mesmo job em paralelo durante o deploy.
 */

export const schedulingJobs: JobDefinition[] = [
  {
    // A tolerância do job é de 60 min; varrer de 15 em 15 marca a falta com meia hora
    // de atraso no pior caso, o que ainda é o mesmo turno de quem está no balcão.
    name: 'agenda.no-show-sweep',
    schedule: '*/15 * * * *',
    run: (now) => sweepNoShows(now),
  },
  {
    // Enquanto `PENDING`, a solicitação **ocupa lugar** na agenda. Cada meia hora sem
    // expirar é meia hora de horário bloqueado por quem talvez nem lembre do pedido.
    name: 'agenda.expire-approvals',
    schedule: '*/30 * * * *',
    run: (now) => expirePendingApprovals(now),
  },
  {
    name: 'agenda.extend-recurrences',
    schedule: '30 3 * * 0',
    run: (now) => extendRecurrences(now),
  },
]
