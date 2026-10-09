import type { TenantTransaction } from '@petshop/db'
import { tenantHasFeature } from '../../shared/plan.js'
import {
  consumeForVaccination,
  returnVaccinationConsumption,
  type VaccinationConsumption,
  type VaccinationLot,
} from '../inventory/consumption.js'
import type { ActorContext } from './actor.js'

/**
 * A porta da carteira de vacinação para o MOD-ESTOQUE — o que a vacina pode fazer com o
 * estoque.
 *
 * O mesmo desenho de `attendances/inventory-port.ts`, pela mesma razão: chamada de
 * função **na transação de quem grava a vacina**, e não evento. Com `DISABLE_EVENTS` a
 * baixa nunca aconteceria, e com o broker de pé haveria a janela em que a carteira diz
 * que a dose foi aplicada e o lote ainda a tem.
 *
 * Dois métodos: baixar a dose e devolvê-la na anulação.
 */
export interface VaccinationInventoryPort {
  /**
   * `null` sem o recurso `INVENTORY`: a vacina é registrada como sempre foi, com o lote
   * digitado, e o estoque não é tocado — o petshop que desceu do Pro não fica sem
   * carteira.
   */
  consume(
    tx: TenantTransaction,
    actor: ActorContext,
    input: VaccinationConsumption,
  ): Promise<VaccinationLot | null>
  returnDose(
    tx: TenantTransaction,
    actor: ActorContext,
    vaccinationId: string,
    reason: string,
  ): Promise<void>
}

function createInProcessPort(): VaccinationInventoryPort {
  return {
    async consume(tx, actor, input) {
      if (!(await tenantHasFeature(actor.tenantId, 'INVENTORY'))) return null
      return consumeForVaccination(tx, actor, input)
    },
    returnDose: returnVaccinationConsumption,
  }
}

let port: VaccinationInventoryPort | null = null

export function getVaccinationInventoryPort(): VaccinationInventoryPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setVaccinationInventoryPort(next: VaccinationInventoryPort | null): void {
  port = next
}
