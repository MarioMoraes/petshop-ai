import type { Tutor, TutorAddress, TutorConsent, TutorTag } from '@petshop/db'
import {
  CURRENT_TERMS_VERSION,
  maskCNPJ,
  maskCPF,
  maskPhone,
  type AddressResponse,
  type ConsentStatus,
  type TutorDetail,
  type TutorResponse,
} from '@petshop/shared-types'
import { decryptOptional, type TutorCipher } from './crypto.js'

/**
 * Linha do banco → contrato da API.
 *
 * É aqui que a PII é mascarada, e é por isso que este é o **único** caminho de saída
 * de um tutor: o dado completo não escapa por engano porque simplesmente não existe
 * no objeto que a rota devolve. Quem precisa do valor cheio (tela de recibo) usa o
 * endpoint dedicado, que audita a leitura.
 */

export interface TutorRowRelations {
  tagAssignments?: { tag: TutorTag }[]
}

export type TutorRow = Tutor & TutorRowRelations

export function toTutorResponse(row: TutorRow, cipher: TutorCipher): TutorResponse {
  const cpf = decryptOptional(cipher, row.cpfEncrypted)
  const cnpj = decryptOptional(cipher, row.cnpjEncrypted)
  const phone = cipher.decrypt(row.phoneEncrypted)
  const phoneAlt = decryptOptional(cipher, row.phoneAltEncrypted)

  return {
    id: row.id,
    tenantId: row.tenantId,
    personType: row.personType,
    fullName: row.fullName,
    // RN-14: o nome social é o nome exibido; o civil só aparece em documento fiscal.
    displayName: row.socialName ?? row.fullName,
    socialName: row.socialName,
    legalName: row.legalName,
    cpfMasked: cpf ? maskCPF(cpf) : null,
    cnpjMasked: cnpj ? maskCNPJ(cnpj) : null,
    phoneMasked: maskPhone(phone),
    phoneAltMasked: phoneAlt ? maskPhone(phoneAlt) : null,
    email: decryptOptional(cipher, row.emailEncrypted),
    birthDate: row.birthDate ? toDateString(row.birthDate) : null,
    notes: row.notes,
    status: row.status,
    dataCompleteness: row.dataCompleteness,
    tags: (row.tagAssignments ?? []).map(({ tag }) => ({
      key: tag.key,
      label: tag.label,
      color: tag.color,
      isSystem: tag.isSystem,
    })),
    petsCount: row.petsCount,
    // Centavos no banco, reais na API: o cliente nunca faz aritmética de dinheiro
    // com o valor que recebe, só exibe.
    balance: row.balanceCents / 100,
    lastAttendanceAt: row.lastAttendanceAt?.toISOString() ?? null,
    mergedIntoId: row.mergedIntoId,
    anonymizedAt: row.anonymizedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toAddressResponse(row: TutorAddress, cipher: TutorCipher): AddressResponse {
  return {
    id: row.id,
    label: row.label,
    zipCode: row.zipCode,
    street: cipher.decrypt(row.streetEncrypted),
    number: cipher.decrypt(row.numberEncrypted),
    complement: decryptOptional(cipher, row.complementEncrypted),
    district: row.district,
    city: row.city,
    state: row.state,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    accessNotes: row.accessNotes,
    isPrimary: row.isPrimary,
  }
}

export function toTutorDetail(
  row: TutorRow,
  cipher: TutorCipher,
  addresses: TutorAddress[],
  consents: TutorConsent[],
): TutorDetail {
  return {
    ...toTutorResponse(row, cipher),
    addresses: addresses.map((address) => toAddressResponse(address, cipher)),
    consents: currentConsentState(consents),
  }
}

/**
 * Estado atual por canal, derivado do histórico append-only (PRD §6).
 *
 * `tutor_consents` só cresce; o "estado" é a transição mais recente de cada canal.
 * Calcular em vez de guardar é o que torna impossível o estado divergir da prova.
 *
 * AC-04 de MOD-TUTOR-04: um aceite de termos numa versão anterior à vigente não é
 * revogação — é `PENDING_RENEWAL`. O tutor continua recebendo comunicação
 * transacional e para de receber marketing até reaceitar.
 */
export function currentConsentState(consents: TutorConsent[]): ConsentStatus[] {
  const latest = new Map<string, TutorConsent>()
  for (const consent of consents) {
    const current = latest.get(consent.channel)
    if (!current || consent.createdAt > current.createdAt) latest.set(consent.channel, consent)
  }

  return [...latest.values()].map((consent) => {
    const staleTerms =
      consent.channel === 'TERMS' && consent.granted && consent.version !== CURRENT_TERMS_VERSION

    return {
      channel: consent.channel,
      state: staleTerms
        ? ('PENDING_RENEWAL' as const)
        : consent.granted
          ? ('GRANTED' as const)
          : ('REVOKED' as const),
      granted: consent.granted,
      purpose: consent.purpose,
      version: consent.version,
      since: consent.createdAt.toISOString(),
    }
  })
}

/** `Date` de coluna `DATE` → `YYYY-MM-DD`, sem deslocar por fuso. */
export function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10)
}
