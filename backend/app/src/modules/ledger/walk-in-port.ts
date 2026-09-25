import type { TenantTransaction } from '@petshop/db'
import {
  walkInSalesBetween,
  walkInSalesByDay,
  type WalkInDayRow,
} from '../inventory/walk-in-sales.js'

/**
 * A porta do MOD-LEDGER para ler as vendas avulsas do MOD-ESTOQUE (MOD-CAIXA).
 *
 * Duas leituras, e só leituras: o relatório por dia e o total de um intervalo. O razão
 * não escreve venda nem sabe o que é lote.
 */
export interface WalkInPort {
  byDay(
    tx: TenantTransaction,
    tenantId: string,
    timezone: string,
    from: string,
    to: string,
  ): Promise<WalkInDayRow[]>
  between(
    tx: TenantTransaction,
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<{ totalCents: number; count: number }>
}

let port: WalkInPort | null = null

export function getWalkInPort(): WalkInPort {
  port ??= { byDay: walkInSalesByDay, between: walkInSalesBetween }
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setWalkInPort(next: WalkInPort | null): void {
  port = next
}
