import type { Allergy, MedicalAlert, Temperament } from '@petshop/db'
import type {
  Allergy as AllergyDto,
  MedicalAlert as MedicalAlertDto,
  Temperament as TemperamentDto,
} from '@petshop/shared-types'
import { decryptOptional, type RecordCipher } from './crypto.js'

/** Linha do banco → contrato da API. Único caminho de saída do prontuário. */

export function toAllergy(row: Allergy, cipher: RecordCipher): AllergyDto {
  return {
    id: row.id,
    petId: row.petId,
    type: row.type,
    label: row.label,
    severity: row.severity,
    reaction: decryptOptional(cipher, row.reactionEncrypted),
    blocksServices: row.blocksServices,
    blocksProducts: row.blocksProducts,
    diagnosedAt: row.diagnosedAt ? row.diagnosedAt.toISOString().slice(0, 10) : null,
    active: row.active,
    resolutionNotes: row.resolutionNotes,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toTemperament(row: Temperament, cipher: RecordCipher): TemperamentDto {
  return {
    id: row.id,
    petId: row.petId,
    classification: row.classification,
    contexts: row.contexts,
    requiresMuzzle: row.requiresMuzzle,
    requiresTwoHandlers: row.requiresTwoHandlers,
    notes: decryptOptional(cipher, row.notesEncrypted),
    observedAt: row.observedAt.toISOString(),
    isCurrent: row.isCurrent,
  }
}

export function toMedicalAlert(row: MedicalAlert, cipher: RecordCipher): MedicalAlertDto {
  return {
    id: row.id,
    petId: row.petId,
    condition: row.condition,
    severity: row.severity,
    instructions: decryptOptional(cipher, row.instructionsEncrypted),
    active: row.active,
    resolutionNotes: row.resolutionNotes,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
