import { PRODUCT_UNIT_LABELS, type ProductUnit } from '@petshop/shared-types'

/**
 * Quantidade para ler: `"12.5"` em ml vira "12,5 ml"; `"3"` em unidade vira "3 unidades".
 *
 * A quantidade chega como string decimal (é assim que o contrato a transporta) e sai no
 * formato do balcão, com vírgula.
 */
export function formatQuantity(quantity: string, unit: ProductUnit): string {
  const value = Number(quantity)
  const text = value.toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  if (unit === 'UN') return `${text} ${Math.abs(value) === 1 ? 'unidade' : 'unidades'}`
  if (unit === 'L') return `${text} ${Math.abs(value) === 1 ? 'litro' : 'litros'}`
  return `${text} ${PRODUCT_UNIT_LABELS[unit]}`
}

/** `2027-03-31` → `31/03/2027`. A data de validade não tem hora nem fuso. */
export function formatExpiry(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** A chave do duplo clique: nasce quando o formulário abre, e não quando ele envia. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
