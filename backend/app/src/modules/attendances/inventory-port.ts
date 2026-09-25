import type { TenantTransaction } from '@petshop/db'
import type { ProductUsed } from '@petshop/shared-types'
import { tenantHasFeature } from '../../shared/plan.js'
import {
  returnAttendanceConsumption,
  syncItemConsumption,
  type ConsumptionContext,
} from '../inventory/consumption.js'
import type { ActorContext } from '../records/actor.js'

/**
 * A porta do MOD-PRONT para o MOD-ESTOQUE — o que o atendimento pode fazer com o estoque.
 *
 * **Chamada de função na transação do atendimento, e não evento** (RN-07 do PRD de
 * estoque): com `DISABLE_EVENTS` a baixa nunca aconteceria, e com o broker de pé haveria
 * a janela em que o prontuário diz que a vacina foi aplicada e o lote ainda a tem. É o
 * mesmo desenho da RN-06 do MOD-IDENT.
 *
 * Dois métodos: levar o estoque a bater com a lista do item, e devolver tudo na
 * anulação.
 */
export interface AttendanceInventoryPort {
  /**
   * Devolve a lista como o prontuário deve guardá-la. Sem o recurso `INVENTORY`, a
   * ligação com o estoque é tirada e a linha fica como texto — é o que o prontuário
   * sempre aceitou (AC-05).
   */
  syncItem(
    tx: TenantTransaction,
    actor: ActorContext,
    context: ConsumptionContext,
    productsUsed: ProductUsed[],
  ): Promise<ProductUsed[]>
  returnAll(
    tx: TenantTransaction,
    actor: ActorContext,
    attendanceItemIds: string[],
    reason: string,
  ): Promise<void>
}

function createInProcessPort(): AttendanceInventoryPort {
  return {
    async syncItem(tx, actor, context, productsUsed) {
      if (!(await tenantHasFeature(actor.tenantId, 'INVENTORY'))) {
        return productsUsed.map(({ name, batch }) => ({ name, ...(batch ? { batch } : {}) }))
      }
      return syncItemConsumption(tx, actor, context, productsUsed)
    },
    returnAll: returnAttendanceConsumption,
  }
}

let port: AttendanceInventoryPort | null = null

export function getInventoryPort(): AttendanceInventoryPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setInventoryPort(next: AttendanceInventoryPort | null): void {
  port = next
}
