import type { JobDefinition } from '@petshop/job-scheduler'
import { reconcileStock } from '../modules/inventory/reconciliation.js'

/**
 * A grade do estoque.
 *
 * A reconciliação roda às 04h10 (MOD-ESTOQUE-12), depois da janela do financeiro (03h00
 * a 03h20) e longe do expurgo do agente (03h50): varreduras cross-tenant no mesmo
 * minuto disputariam o pool do Prisma entre si.
 */

export const inventoryJobs: JobDefinition[] = [
  {
    name: 'inventory.reconciliation',
    schedule: '10 4 * * *',
    run: () => reconcileStock(),
  },
]
