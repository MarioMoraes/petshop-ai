import type { Breed, Coat, Pet, PetTutor, Size, Species, TenantTransaction, Tutor } from '@petshop/db'
import {
  formatAgeLabel,
  maskMicrochip,
  maskPhone,
  monthsBetween,
  type PetResponse,
  type PetTutorLink,
  type PetWarning,
} from '@petshop/shared-types'
import { coverUrlsFor } from '../photos/service.js'
import { decryptOptional, type PetCipher } from './crypto.js'

/**
 * Linha do banco → contrato da API.
 *
 * Caminho único de saída de um pet: o microchip sai mascarado porque o objeto que a
 * rota devolve simplesmente não tem o número inteiro. Quem precisa dele usa
 * `GET /v1/pets/:id/sensitive`, que audita a leitura.
 */

export type PetRow = Pet & {
  species: Species
  breed: Breed | null
  size: Size
  coat: Coat | null
  petTutors?: (PetTutor & { tutor: Tutor })[]
}

/**
 * AC-04: peso fora da faixa do porte **avisa**. O buldogue de 32 kg e o gato de 9 kg
 * existem, e recusá-los faria a recepção inventar um porte errado só para salvar —
 * o que estragaria o cálculo de duração do banho (RN-03).
 */
export function weightWarnings(weightKg: number | null, size: Pick<Size, 'weightMinKg' | 'weightMaxKg'>): PetWarning[] {
  if (weightKg === null) return []
  const min = Number(size.weightMinKg)
  const max = Number(size.weightMaxKg)
  if (weightKg >= min && weightKg <= max) return []
  return [{ code: 'WEIGHT_SIZE_MISMATCH', message: 'Peso incompatível com o porte selecionado' }]
}

/**
 * Idade em meses completos. `UNKNOWN` devolve `null` em vez de zero: "não sabemos"
 * e "recém-nascido" são coisas diferentes para a dosagem clínica.
 */
export function ageMonthsOf(pet: Pick<Pet, 'birthDate' | 'birthDatePrecision'>, now = new Date()): number | null {
  if (!pet.birthDate || pet.birthDatePrecision === 'UNKNOWN') return null
  return monthsBetween(pet.birthDate, now)
}

export function toPetTutorLink(link: PetTutor & { tutor: Tutor }, cipher: PetCipher): PetTutorLink {
  return {
    linkId: link.id,
    tutorId: link.tutorId,
    // RN-14 do MOD-TUTOR: o nome social é o nome exibido.
    fullName: link.tutor.socialName ?? link.tutor.fullName,
    phoneMasked: maskTutorPhone(link.tutor, cipher),
    role: link.role,
    relationship: link.relationship,
    canAuthorizeProcedures: link.canAuthorizeProcedures,
    linkedAt: link.linkedAt.toISOString(),
  }
}

/**
 * Tutor anonimizado tem `phone_encrypted = ''` (MOD-TUTOR-08): decifrar string vazia
 * estouraria, então o vínculo sai sem telefone em vez de derrubar a leitura do pet.
 */
function maskTutorPhone(tutor: Tutor, cipher: PetCipher): string {
  if (!tutor.phoneEncrypted) return ''
  return maskPhone(cipher.decrypt(tutor.phoneEncrypted))
}

/**
 * Preenche a capa das respostas já mapeadas (MOD-PET-04).
 *
 * Existe como passo à parte para que todo caminho de leitura — listagem, detalhe,
 * recarga depois de escrever — passe pelo mesmo lugar. Antes disso, cada ponto de
 * saída tinha de lembrar de assinar a URL, e esquecer em um deles significaria a foto
 * sumir da tela sem motivo aparente.
 */
export async function attachCoverUrls(
  tx: TenantTransaction,
  rows: Pick<Pet, 'id' | 'coverPhotoId'>[],
  responses: PetResponse[],
): Promise<PetResponse[]> {
  const urls = await coverUrlsFor(tx, rows)
  if (urls.size === 0) return responses

  for (const response of responses) {
    response.coverPhotoUrl = urls.get(response.id) ?? null
  }
  return responses
}

export function toPetResponse(row: PetRow, cipher: PetCipher, now = new Date()): PetResponse {
  const microchip = decryptOptional(cipher, row.microchipEncrypted)
  const weightKg = row.weightKg === null ? null : Number(row.weightKg)
  const ageMonths = ageMonthsOf(row, now)

  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    species: { id: row.species.id, key: row.species.key, label: row.species.label },
    breed: row.breed ? { id: row.breed.id, label: row.breed.label } : null,
    size: { id: row.size.id, key: row.size.key, label: row.size.label },
    coat: row.coat ? { id: row.coat.id, key: row.coat.key, label: row.coat.label } : null,
    sex: row.sex,
    birthDate: row.birthDate ? toDateString(row.birthDate) : null,
    birthDatePrecision: row.birthDatePrecision,
    ageMonths,
    ageLabel: formatAgeLabel(ageMonths, row.birthDatePrecision),
    weightKg,
    neutered: row.neutered,
    microchipMasked: microchip ? maskMicrochip(microchip) : null,
    color: row.color,
    // Preenchido depois, por `attachCoverUrls`: assinar a URL depende do storage, e o
    // mapper é síncrono de propósito — ele traduz linha em contrato, não busca dado.
    coverPhotoUrl: null,
    status: row.status,
    deceasedAt: row.deceasedAt ? toDateString(row.deceasedAt) : null,
    notes: decryptOptional(cipher, row.notesEncrypted),
    // TODO(MOD-PRONT): RN-09 agrega aqui as alergias e o temperamento do prontuário.
    alerts: [],
    tutors: (row.petTutors ?? []).map((link) => toPetTutorLink(link, cipher)),
    warnings: weightWarnings(weightKg, row.size),
    lastAttendanceAt: row.lastAttendanceAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** `Date` de coluna `DATE` → `YYYY-MM-DD`, sem deslocar por fuso. */
export function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10)
}
