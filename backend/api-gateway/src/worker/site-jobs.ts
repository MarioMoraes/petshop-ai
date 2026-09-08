import type { JobDefinition } from '@petshop/job-scheduler'
import { runLeadRetention } from '../modules/site/jobs.js'

/**
 * A grade do site — um job só.
 *
 * Roda de madrugada porque é limpeza, não operação: nada do que ele faz precisa
 * acontecer durante o expediente, e apagar dado enquanto a recepção olha a fila só
 * confundiria.
 *
 * **O que não está aqui:** o `site-health-check` do §10 do PRD, que verificaria de 15
 * em 15 minutos se cada site publicado responde 200. O destino da falha dele é o
 * alerta do MOD-ADMIN, que não existe — e job que grita para ninguém é ruído com custo
 * de banco. Ele entra junto com o painel que o escuta.
 */

export const siteJobs: JobDefinition[] = [
  {
    name: 'site.leads-retention',
    schedule: '20 3 * * *',
    run: (now) => runLeadRetention(now),
  },
]
