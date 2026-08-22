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
