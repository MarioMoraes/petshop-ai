import type { TenantTransaction } from '@petshop/db'
import type { TaxiAddressInput } from '@petshop/shared-types'
import { missingAddress } from '../../lib/errors.js'
import type { TaxiCipher } from './crypto.js'

/**
 * De onde vem o endereço da corrida (MOD-TAXI-02).
 *
 * O endereço é **copiado** para a corrida, cifrado, e não referenciado por FK viva
 * (RN-11): `address_id` guarda só a procedência. O motivo é histórico, não técnico —
 * quando alguém pergunta meses depois "para onde o motorista levou o Thor?", a
 * resposta tem de ser o endereço daquele dia, e não o que o tutor cadastrou desde
 * então.
 */

export interface ResolvedAddress {
  addressId: string | null
  zipCode: string
  streetEncrypted: string
  numberEncrypted: string
  complementEncrypted: string | null
  accessNotesEncrypted: string | null
  district: string
  city: string
  state: string
  latitude: string | null
  longitude: string | null
}

export async function resolveAddress(
  tx: TenantTransaction,
  cipher: TaxiCipher,
  tutorId: string,
  input: TaxiAddressInput | undefined,
): Promise<ResolvedAddress> {
  if (input) {
    return {
      addressId: null,
      zipCode: input.zipCode,
      streetEncrypted: cipher.encrypt(input.street),
      numberEncrypted: cipher.encrypt(input.number),
      complementEncrypted: input.complement ? cipher.encrypt(input.complement) : null,
      accessNotesEncrypted: input.accessNotes ? cipher.encrypt(input.accessNotes) : null,
      district: input.district,
      city: input.city,
      state: input.state,
      latitude: null,
      longitude: null,
    }
  }

  // AC-01: sem endereço informado, herda o primário do tutor. `is_primary` é único
  // por tutor (RN-15 do MOD-TUTOR), então não há desempate a fazer aqui.
  const address = await tx.tutorAddress.findFirst({
    where: { tutorId, isPrimary: true },
  })
  if (!address) throw missingAddress()

  return {
    addressId: address.id,
    zipCode: address.zipCode,
    // Os campos já estão cifrados com a **mesma** DEK do tenant: copiar o texto
    // cifrado evita decifrar e recifrar por nada, e evita que o endereço em claro
    // exista em memória neste caminho.
    streetEncrypted: address.streetEncrypted,
    numberEncrypted: address.numberEncrypted,
    complementEncrypted: address.complementEncrypted,
    accessNotesEncrypted: address.accessNotes,
    district: address.district,
    city: address.city,
    state: address.state,
    latitude: address.latitude === null ? null : address.latitude.toString(),
    longitude: address.longitude === null ? null : address.longitude.toString(),
  }
}
