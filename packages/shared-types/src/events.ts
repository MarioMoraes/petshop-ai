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
  // MOD-IDENT-06. O PRD §8 nomeia estes três em inglês (`invitation.created`), mas
  // as outras dezoito chaves deste serviço estão em português — uma família só de
  // exceções obrigaria todo consumidor a lembrar de qual módulo veio o evento.
  conviteCriado: 'convite.criado',
  conviteRevogado: 'convite.revogado',
  conviteAceito: 'convite.aceito',
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

/**
 * O e-mail do convidado **não** entra em nenhum destes payloads. O broker não é
 * lugar de PII: a fila fica retida, é lida por qualquer consumidor futuro e sobrevive
 * ao expurgo do banco. Quem precisar do endereço consulta `invitations` sob RLS.
 */
export interface ConviteCriadoEvent extends BaseEvent {
  tenantId: string
  invitationId: string
  roleKey: RoleKey
  invitedByUserId: string
}

export interface ConviteRevogadoEvent extends BaseEvent {
  tenantId: string
  invitationId: string
  actorUserId: string
}

export interface ConviteAceitoEvent extends BaseEvent {
  tenantId: string
  invitationId: string
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
  'convite.criado': ConviteCriadoEvent
  'convite.revogado': ConviteRevogadoEvent
  'convite.aceito': ConviteAceitoEvent
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
  'inadimplencia.detectada',
  'inadimplencia.resolvida',
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
  atendimentoAnulado: 'atendimento.anulado',
} as const

export type RecordRoutingKey = (typeof RECORD_ROUTING_KEYS)[keyof typeof RECORD_ROUTING_KEYS]

/**
 * Eventos que o medical-record-service consome (PRD prontuario_04 §8).
 *
 * `atendimento.iniciado` e `atendimento.concluido` são o que **cria** o registro
 * clínico: o prontuário não tem um POST de criação porque o atendimento é um fato da
 * operação, e quem o produz é o balcão movendo o pet pelo dia.
 */
export const RECORD_CONSUMED_ROUTING_KEYS = [
  'atendimento.iniciado',
  'atendimento.concluido',
  'pet.obito',
  'pet.transferido',
] as const

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

/**
 * Um atendimento foi anulado (MOD-PRONT-09, AC-03).
 *
 * O registro **não** é excluído — vai a `VOIDED` e continua na linha do tempo,
 * riscado. Quem consome é o MOD-LEDGER, que estorna o débito por contrapartida:
 * dinheiro lançado por engano se corrige com outro lançamento, nunca apagando o
 * primeiro.
 */
export interface AtendimentoAnuladoEvent extends BaseEvent {
  tenantId: string
  attendanceId: string
  /** Nulo no registro de reparo que nunca teve agendamento. */
  appointmentId: string | null
  petId: string
  tutorId: string
  reason: string
  voidedBy: string | null
}

export interface RecordEventMap {
  'prontuario.alerta.alterado': ProntuarioAlertaAlteradoEvent
  'atendimento.anulado': AtendimentoAnuladoEvent
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
  /**
   * MOD-PRONT-01: o encaixe chega por aqui com `WALK_IN`, e é o único sinal que
   * distingue "não tinha hora marcada" de "foi agendado" depois que o agendamento
   * retroativo já existe na tabela como qualquer outro.
   */
  origin?: 'SCHEDULED' | 'WALK_IN'
  /** Hora real de início — o check-in, ou o horário marcado quando não houve. */
  startedAt?: string
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

// ─── MOD-LEDGER ──────────────────────────────────────────────────────────────
// PRD financeiro_tutor_05 §8.

export const LEDGER_ROUTING_KEYS = {
  lancamentoCriado: 'lancamento.criado',
  lancamentoEstornado: 'lancamento.estornado',
  saldoAlterado: 'saldo.alterado',
  pagamentoRegistrado: 'pagamento.registrado',
  pagamentoEstornado: 'pagamento.estornado',
  pacoteComprado: 'pacote.comprado',
  pacoteCreditoConsumido: 'pacote.credito.consumido',
  pacoteConsumido: 'pacote.consumido',
  pacoteExpirado: 'pacote.expirado',
  reciboEmitido: 'recibo.emitido',
  inadimplenciaDetectada: 'inadimplencia.detectada',
  inadimplenciaResolvida: 'inadimplencia.resolvida',
} as const

export type LedgerRoutingKey = (typeof LEDGER_ROUTING_KEYS)[keyof typeof LEDGER_ROUTING_KEYS]

/** Eventos que o billing-ledger-service consome (PRD §8, parágrafo final). */
export const LEDGER_CONSUMED_ROUTING_KEYS = [
  'atendimento.concluido',
  'atendimento.anulado',
  'pet.obito',
  'pet.transferido',
  'tutor.mesclado',
  'tutor.anonimizado',
] as const

/**
 * Um lançamento entrou na conta.
 *
 * `balanceCents` é redundante com `balanceAfterCents` de propósito: o
 * `tutor-service` já consome este evento desde o MOD-TUTOR para manter
 * `tutors.balance_cents` e a tag INADIMPLENTE, e o campo que ele lê chama-se
 * `balanceCents`. Publicar o superset é o que permite ligar o ledger sem tocar em
 * consumidor nenhum.
 */
export interface LancamentoCriadoEvent extends BaseEvent {
  tenantId: string
  entryId: string
  tutorId: string
  direction: 'DEBIT' | 'CREDIT'
  amountCents: number
  category: string
  balanceAfterCents: number
  /** Mesmo valor de `balanceAfterCents`; ver a nota acima. */
  balanceCents: number
  occurredAt: string
}

export interface LancamentoEstornadoEvent extends BaseEvent {
  tenantId: string
  entryId: string
  tutorId: string
  reversalEntryId: string
  reason: string
  reversedBy: string | null
  balanceCents: number
}

export interface SaldoAlteradoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  balanceCents: number
  previousBalanceCents: number
}

export interface PagamentoRegistradoEvent extends BaseEvent {
  tenantId: string
  paymentId: string
  tutorId: string
  amountCents: number
  method: string
  receivedAt: string
  balanceCents: number
}

export interface PagamentoEstornadoEvent extends BaseEvent {
  tenantId: string
  paymentId: string
  tutorId: string
  reason: string
  reversedBy: string | null
  balanceCents: number
}

export interface PacoteCompradoEvent extends BaseEvent {
  tenantId: string
  purchaseId: string
  tutorId: string
  petId: string | null
  packageName: string
  creditsTotal: number
  expiresAt: string
}

export interface PacoteCreditoConsumidoEvent extends BaseEvent {
  tenantId: string
  purchaseId: string
  tutorId: string
  attendanceId: string
  creditsRemaining: number
  expiresAt: string
}

export interface PacoteConsumidoEvent extends BaseEvent {
  tenantId: string
  purchaseId: string
  tutorId: string
}

/**
 * RN-08: o crédito venceu e **nada é devolvido**.
 *
 * `creditsLost` vai no payload porque é o número que o MOD-CRM usa para calibrar a
 * oferta de recompra — e porque `package_expiry_waste_cents` é métrica de alerta,
 * não de receita: expiração alta é cliente frustrado a caminho do churn.
 */
export interface PacoteExpiradoEvent extends BaseEvent {
  tenantId: string
  purchaseId: string
  tutorId: string
  creditsLost: number
  expiredAt: string
}

/**
 * O comprovante ficou pronto (MOD-LEDGER-08).
 *
 * Sai **depois** do `pagamento.registrado`, e não junto: o PDF é gerado fora da
 * transação e pode demorar — ou falhar e só sair no reprocesso. Quem quiser anexar o
 * recibo a um e-mail espera por este, não por aquele.
 */
export interface ReciboEmitidoEvent extends BaseEvent {
  tenantId: string
  receiptId: string
  paymentId: string
  tutorId: string
  number: string
}

/**
 * RN-16 — a inadimplência começou.
 *
 * O gatilho é o **atraso**, não o sinal do saldo: `billing_settings.overdue_days` (30
 * por padrão) define quando um débito em aberto vira inadimplência. Quem fez banho de
 * manhã e paga na saída deve dinheiro o dia inteiro sem ser inadimplente — e marcá-lo
 * como tal seria a plataforma insultando o cliente do petshop.
 */
export interface InadimplenciaDetectadaEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  balanceCents: number
  overdueDays: number
  oldestOpenDebitAt: string
}

export interface InadimplenciaResolvidaEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  settledAt: string
}

export interface LedgerEventMap {
  'lancamento.criado': LancamentoCriadoEvent
  'lancamento.estornado': LancamentoEstornadoEvent
  'saldo.alterado': SaldoAlteradoEvent
  'pagamento.registrado': PagamentoRegistradoEvent
  'pagamento.estornado': PagamentoEstornadoEvent
  'pacote.comprado': PacoteCompradoEvent
  'pacote.credito.consumido': PacoteCreditoConsumidoEvent
  'pacote.consumido': PacoteConsumidoEvent
  'pacote.expirado': PacoteExpiradoEvent
  'recibo.emitido': ReciboEmitidoEvent
  'inadimplencia.detectada': InadimplenciaDetectadaEvent
  'inadimplencia.resolvida': InadimplenciaResolvidaEvent
}
