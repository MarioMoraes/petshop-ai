import type { JobDefinition } from '@petshop/job-scheduler'
import { checkQueueHealth, purgeExpiredBodies, runDispatch } from '../modules/messaging/jobs.js'

/**
 * A grade do relacionamento.
 *
 * O despacho é o job mais frequente do sistema inteiro — de meio em meio minuto —
 * porque a mensagem transacional é sobre agora: uma confirmação de agendamento que
 * chega dez minutos depois do cliente sair do balcão já não confirma nada.
 *
 * A grade do `job-scheduler` é minuto a minuto, então o passo de 30s é feito com dois
 * jobs deslocados. É feio e é honesto: o alternativo seria um `setInterval` paralelo,
 * fora do lease do Postgres, e aí dois processos despachariam a mesma fila.
 */

export const messagingJobs: JobDefinition[] = [
  {
    name: 'messaging.dispatch',
    schedule: '* * * * *',
    run: (now) => runDispatch(now),
  },
  {
    // A varredura de saúde precisa de um horizonte de 30 minutos; olhar de minuto em
    // minuto não anteciparia a descoberta em nada.
    name: 'messaging.queue-health',
    schedule: '*/10 * * * *',
    run: (now) => checkQueueHealth(now),
  },
  {
    name: 'messaging.retention',
    schedule: '20 3 * * *',
    run: (now) => purgeExpiredBodies(now),
  },
  
]
