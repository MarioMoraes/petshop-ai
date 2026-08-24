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

/** MOD-PRONT — eventos do prontuário (PRD prontuario_04 §8). */
export const RECORD_ROUTING_KEYS = {
  alertaAlterado: 'prontuario.alerta.alterado',
} as const

export type RecordRoutingKey = (typeof RECORD_ROUTING_KEYS)[keyof typeof RECORD_ROUTING_KEYS]

/**
 * Um alerta de segurança do pet mudou: alergia, temperamento ou condição médica.
 *
 * O payload carrega o **efeito**, não a causa: quem consome precisa saber que o pet
 * X mudou de estado de alerta para invalidar cache e revalidar agendamento futuro.
 * O conteúdo clínico fica no serviço que o guarda.
 */
export interface ProntuarioAlertaAlteradoEvent extends BaseEvent {
  tenantId: string
  petId: string
  kind: 'ALLERGY' | 'TEMPERAMENT' | 'MEDICAL'
  action: 'CREATED' | 'UPDATED' | 'DEACTIVATED'
  /** Maior severidade ativa depois da mudança; `null` quando não há alerta. */
  highestSeverity: string | null
}

export interface RecordEventMap {
  'prontuario.alerta.alterado': ProntuarioAlertaAlteradoEvent
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

// ─── MOD-AGENDA ──────────────────────────────────────────────────────────────
// PRD agenda_operacao_06 §8.

export const AGENDA_ROUTING_KEYS = {
  agendamentoSolicitado: 'agendamento.solicitado',
  agendamentoCriado: 'agendamento.criado',
  agendamentoReagendado: 'agendamento.reagendado',
  agendamentoCancelado: 'agendamento.cancelado',
  agendamentoNoShow: 'agendamento.no_show',
  atendimentoIniciado: 'atendimento.iniciado',
  atendimentoConcluido: 'atendimento.concluido',
  bloqueioCriado: 'agenda.bloqueio.criado',
  servicoAlterado: 'agenda.servico.alterado',
  profissionalAlterado: 'agenda.profissional.alterado',
} as const

export type AgendaRoutingKey = (typeof AGENDA_ROUTING_KEYS)[keyof typeof AGENDA_ROUTING_KEYS]

/** Eventos que o scheduling-service consome (PRD §8, parágrafo final). */
export const AGENDA_CONSUMED_ROUTING_KEYS = [
  'pet.obito',
  'pet.transferido',
  'tutor.anonimizado',
  'tutor.mesclado',
  'lancamento.criado',
] as const

/**
 * Um bloqueio entrou na agenda. `professionalId` nulo é o feriado do tenant inteiro.
 *
 * `cancelledAppointmentIds` existe porque o AC-02 permite cancelar em lote junto com
 * a criação do bloqueio: quem consome (CRM, notificação) precisa saber **quais**
 * agendamentos caíram para avisar os tutores, e um evento por agendamento cancelado
 * separaria a causa do efeito.
 */
export interface AgendaBloqueioCriadoEvent extends BaseEvent {
  tenantId: string
  blockId: string
  professionalId: string | null
  startsAt: string
  endsAt: string
  cancelledAppointmentIds: string[]
}

/**
 * O catálogo do que se vende mudou. Carrega o **efeito** e não o conteúdo: quem
 * consome (Portal, site do tenant) precisa saber que o seletor mudou para invalidar
 * cache, não quanto passou a custar o banho.
 */
export interface AgendaServicoAlteradoEvent extends BaseEvent {
  tenantId: string
  serviceId: string
  action: 'CREATED' | 'UPDATED' | 'DEACTIVATED' | 'PRICING_CHANGED'
}

export interface AgendaProfissionalAlteradoEvent extends BaseEvent {
  tenantId: string
  professionalId: string
  action: 'CREATED' | 'UPDATED' | 'DEACTIVATED' | 'SCHEDULE_CHANGED'
}

/**
 * O tutor pediu um horário e o petshop ainda não decidiu (AC-03 de MOD-AGENDA-06).
 *
 * Separado de `agendamento.criado` de propósito: quem consome `criado` manda a
 * confirmação ao tutor, e confirmar algo que ainda pode ser recusado é pior do que
 * não avisar. Este aqui alimenta a fila da recepção.
 */
export interface AgendamentoSolicitadoEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  petId: string
  tutorId: string
  startsAt: string
}

export interface AgendamentoCriadoEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  petId: string
  tutorId: string
  professionalId: string
  startsAt: string
  endsAt: string
  totalCents: number
  source: 'STAFF' | 'PORTAL' | 'RECURRENCE' | 'AI_AGENT'
}

export interface AtendimentoIniciadoEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  petId: string
  professionalId: string
}

/**
 * O evento mais consumido do sistema.
 *
 * Dele nascem o débito (MOD-LEDGER), o registro clínico (MOD-PRONT-01), o
 * `pets.last_attendance_at` e a régua de relacionamento. Carrega os itens **com o
 * preço congelado**, e não os ids dos serviços: quem lança o débito não pode
 * reconsultar o catálogo, que já pode ter mudado de preço desde o agendamento.
 */
export interface AtendimentoConcluidoEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  petId: string
  tutorId: string
  professionalId: string
  items: { serviceId: string; label: string; priceCents: number }[]
  totalCents: number
  /** Pesagem aferida no check-in, quando houve (MOD-PET-07). */
  weightKg: number | null
}

export interface AgendamentoCanceladoEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  /** RN-06: dentro da janela de cancelamento. É o que decide a taxa. */
  late: boolean
  feeCents: number
  cancelledBy: string | null
}

export interface AgendamentoNoShowEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  tutorId: string
  feeCents: number
}

export interface AgendamentoReagendadoEvent extends BaseEvent {
  tenantId: string
  appointmentId: string
  newAppointmentId: string
  startsAt: string
  /** RN-16: "quantas vezes remarcou" é dado de negócio. */
  rescheduleCount: number
}

export interface AgendaEventMap {
  'agenda.bloqueio.criado': AgendaBloqueioCriadoEvent
  'agenda.servico.alterado': AgendaServicoAlteradoEvent
  'agenda.profissional.alterado': AgendaProfissionalAlteradoEvent
  'agendamento.solicitado': AgendamentoSolicitadoEvent
  'agendamento.criado': AgendamentoCriadoEvent
  'agendamento.cancelado': AgendamentoCanceladoEvent
  'agendamento.no_show': AgendamentoNoShowEvent
  'agendamento.reagendado': AgendamentoReagendadoEvent
  'atendimento.iniciado': AtendimentoIniciadoEvent
  'atendimento.concluido': AtendimentoConcluidoEvent
}
