/**
 * Eventos de domínio publicados no exchange topic `petshop.events`
 * (PRD identidade_tenancy_01 §8; convenção `dominio.acao` do SPEC §11).
 */

import type { Plan, TenantStatus } from './identity.js'
import type { RoleKey } from './permissions.js'
import type { ConsentChannel, ConsentPurpose } from './tutor.js'

export const EVENTS_EXCHANGE = 'petshop.events'
export const EVENTS_DLX = 'petshop.events.dlx'

/** Backoff exponencial do DLX; após a 4ª tentativa a mensagem vai para a DLQ. */
export const EVENT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 300_000] as const

export const IDENTITY_ROUTING_KEYS = {
  tenantCriado: 'tenant.criado',
  tenantOnboardingConcluido: 'tenant.onboarding.concluido',
  tenantAtivado: 'tenant.ativado',
  tenantSuspenso: 'tenant.suspenso',
  tenantReativado: 'tenant.reativado',
  tenantEncerrado: 'tenant.encerrado',
  tenantConfiguracaoAtualizada: 'tenant.configuracao.atualizada',
  membershipCriado: 'membership.criado',
  membershipPapelAlterado: 'membership.papel_alterado',
  membershipRemovido: 'membership.removido',
  usuarioSincronizado: 'usuario.sincronizado',
} as const

export type IdentityRoutingKey =
  (typeof IDENTITY_ROUTING_KEYS)[keyof typeof IDENTITY_ROUTING_KEYS]

interface BaseEvent {
  timestamp: string
}

export interface TenantCriadoEvent extends BaseEvent {
  tenantId: string
  slug: string
  plan: Plan
  adminUserId: string
}

export interface TenantOnboardingConcluidoEvent extends BaseEvent {
  tenantId: string
  durationSeconds: number
  stepsSkipped: number[]
}

export interface TenantStatusAlteradoEvent extends BaseEvent {
  tenantId: string
  previousStatus: TenantStatus
  newStatus: TenantStatus
  reason: string
}

export interface TenantConfiguracaoAtualizadaEvent extends BaseEvent {
  tenantId: string
  changedKeys: string[]
}

export interface MembershipCriadoEvent extends BaseEvent {
  tenantId: string
  userId: string
  roleKey: RoleKey
  isProfessional: boolean
}

export interface MembershipPapelAlteradoEvent extends BaseEvent {
  tenantId: string
  userId: string
  fromRole: RoleKey
  toRole: RoleKey
  actorUserId: string
}

export interface MembershipRemovidoEvent extends BaseEvent {
  tenantId: string
  userId: string
  roleKey: RoleKey
}

/** Mapa routing key → payload, usado para tipar o publisher. */
export interface IdentityEventMap {
  'tenant.criado': TenantCriadoEvent
  'tenant.onboarding.concluido': TenantOnboardingConcluidoEvent
  'tenant.ativado': TenantStatusAlteradoEvent
  'tenant.suspenso': TenantStatusAlteradoEvent
  'tenant.reativado': TenantStatusAlteradoEvent
  'tenant.encerrado': TenantStatusAlteradoEvent
  'tenant.configuracao.atualizada': TenantConfiguracaoAtualizadaEvent
  'membership.criado': MembershipCriadoEvent
  'membership.papel_alterado': MembershipPapelAlteradoEvent
  'membership.removido': MembershipRemovidoEvent
  'usuario.sincronizado': BaseEvent & {
    userId: string
    clerkUserId: string
    changedFields: string[]
  }
}

// ─── MOD-TUTOR ───────────────────────────────────────────────────────────────
// PRD tutores_02 §8.

export const TUTOR_ROUTING_KEYS = {
  tutorCriado: 'tutor.criado',
  tutorAtualizado: 'tutor.atualizado',
  tutorInativado: 'tutor.inativado',
  tutorConsentimentoConcedido: 'tutor.consentimento.concedido',
  tutorConsentimentoRevogado: 'tutor.consentimento.revogado',
  tutorMesclado: 'tutor.mesclado',
  tutorAnonimizado: 'tutor.anonimizado',
  tutorTagAplicada: 'tutor.tag.aplicada',
  tutorTagRemovida: 'tutor.tag.removida',
} as const

export type TutorRoutingKey = (typeof TUTOR_ROUTING_KEYS)[keyof typeof TUTOR_ROUTING_KEYS]

/** Eventos que o tutor-service consome (PRD §8, parágrafo final). */
export const TUTOR_CONSUMED_ROUTING_KEYS = [
  'atendimento.concluido',
  'lancamento.criado',
  'mensagem.recebida',
] as const

export interface TutorCriadoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  /** E.164 — o agente de IA resolve a conversa de WhatsApp por ele. */
  phone: string
  hasWhatsappConsent: boolean
}

export interface TutorAtualizadoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  changedFields: string[]
}

export interface TutorInativadoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  lastAttendanceAt: string | null
}

export interface TutorConsentimentoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  channel: ConsentChannel
  purpose: ConsentPurpose
  version: string
}

export interface TutorMescladoEvent extends BaseEvent {
  tenantId: string
  sourceId: string
  targetId: string
  movedEntities: Record<string, string[]>
}

export interface TutorAnonimizadoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
}

export interface TutorTagEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  tagKey: string
  automatic: boolean
}

export interface TutorEventMap {
  'tutor.criado': TutorCriadoEvent
  'tutor.atualizado': TutorAtualizadoEvent
  'tutor.inativado': TutorInativadoEvent
  'tutor.consentimento.concedido': TutorConsentimentoEvent
  'tutor.consentimento.revogado': TutorConsentimentoEvent
  'tutor.mesclado': TutorMescladoEvent
  'tutor.anonimizado': TutorAnonimizadoEvent
  'tutor.tag.aplicada': TutorTagEvent
  'tutor.tag.removida': TutorTagEvent
}

// ─── MOD-PET ─────────────────────────────────────────────────────────────────
// PRD pets_03 §8.

export const PET_ROUTING_KEYS = {
  petCriado: 'pet.criado',
  petAtualizado: 'pet.atualizado',
  petTransferido: 'pet.transferido',
  petObito: 'pet.obito',
  petInativado: 'pet.inativado',
  petFotoAdicionada: 'pet.foto.adicionada',
  petPesoRegistrado: 'pet.peso.registrado',
  petVinculoAlterado: 'pet.vinculo.alterado',
} as const

export type PetRoutingKey = (typeof PET_ROUTING_KEYS)[keyof typeof PET_ROUTING_KEYS]

/** Eventos que o pet-service consome (PRD pets_03 §8, parágrafo final). */
export const PET_CONSUMED_ROUTING_KEYS = [
  'tutor.anonimizado',
  'tutor.mesclado',
  'atendimento.concluido',
] as const

export interface PetCriadoEvent extends BaseEvent {
  tenantId: string
  petId: string
  /** Chave do catálogo, não o UUID: quem consome segmenta por espécie, não por id. */
  speciesKey: string
  primaryTutorId: string
  birthDate: string | null
}

export interface PetAtualizadoEvent extends BaseEvent {
  tenantId: string
  petId: string
  changedFields: string[]
}

export interface PetTransferidoEvent extends BaseEvent {
  tenantId: string
  petId: string
  fromTutorId: string
  toTutorId: string
  reason: string
}

export interface PetObitoEvent extends BaseEvent {
  tenantId: string
  petId: string
  tutorIds: string[]
  deceasedAt: string | null
}

export interface PetInativadoEvent extends BaseEvent {
  tenantId: string
  petId: string
  lastAttendanceAt: string | null
}

export interface PetFotoAdicionadaEvent extends BaseEvent {
  tenantId: string
  petId: string
  photoId: string
  source: string
  attendanceId: string | null
}

export interface PetPesoRegistradoEvent extends BaseEvent {
  tenantId: string
  petId: string
  weightKg: number
  previousWeightKg: number | null
  /** RN-11: variação acima de 15% em 60 dias vira alerta ao veterinário. */
  variationPercent: number | null
}

/** `action` distingue vínculo criado, alterado e encerrado (MOD-PET-02). */
export interface PetVinculoAlteradoEvent extends BaseEvent {
  tenantId: string
  petId: string
  tutorId: string
  action: 'LINKED' | 'UPDATED' | 'UNLINKED'
  role: 'PRIMARY' | 'SECONDARY'
}

export interface PetEventMap {
  'pet.criado': PetCriadoEvent
  'pet.atualizado': PetAtualizadoEvent
  'pet.transferido': PetTransferidoEvent
  'pet.obito': PetObitoEvent
  'pet.inativado': PetInativadoEvent
  'pet.foto.adicionada': PetFotoAdicionadaEvent
  'pet.peso.registrado': PetPesoRegistradoEvent
  'pet.vinculo.alterado': PetVinculoAlteradoEvent
}
