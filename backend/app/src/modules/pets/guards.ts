import type { Pet } from '@petshop/db'
import { conflict } from './errors.js'

/**
 * Regras de escrita que outras partes do MOD-PET conferem antes de gravar.
 *
 * Moram fora de `service.ts` para não fechar ciclo de import: `photos/service.ts`
 * precisa desta guarda, e `service.ts` importa o mapper, que importa `photos/service.ts`
 * pela URL da capa.
 */

/** Estados terminais recusam escrita: o pet não é mais deste tenant, ou não vive mais. */
export function assertWritable(row: Pick<Pet, 'status'>): void {
  if (row.status === 'TRANSFERRED_OUT') {
    throw conflict('Este pet foi transferido para outro estabelecimento e não aceita alterações')
  }
  if (row.status === 'DECEASED') {
    throw conflict('Este pet está registrado como falecido. Reverta o óbito para editar.')
  }
}
