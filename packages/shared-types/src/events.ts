/**
 * Eventos de domínio publicados no exchange topic `petshop.events`
 * (PRD identidade_tenancy_01 §8; convenção `dominio.acao` do SPEC §11).
 */

import type { Plan, TenantStatus } from './identity.js'
import type { RoleKey } from './permissions.js'
import type { TermKind } from './terms.js'
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
  /**
   * Quem terminou o wizard, e portanto quem recebe as boas-vindas (MOD-NOTIF-08).
   *
   * Opcional porque o evento existe desde o MOD-IDENT-02 e ninguém o consumia; quem
   * conclui o onboarding é sempre um usuário autenticado, mas o caminho de reprocesso
   * do provisionamento pode chegar aqui sem ator.
   */
  adminUserId?: string | null
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
  /** MOD-DOC-07 e 08: o aceite de um termo, com o papel que o arquiva. */
  tutorTermoAceito: 'tutor.termo.aceito',
} as const

export type TutorRoutingKey = (typeof TUTOR_ROUTING_KEYS)[keyof typeof TUTOR_ROUTING_KEYS]

/** Eventos que o tutor-service consome (PRD §8, parágrafo final). */
export const TUTOR_CONSUMED_ROUTING_KEYS = [
  'atendimento.concluido',
  'lancamento.criado',
  'inadimplencia.detectada',
  'inadimplencia.resolvida',
  'mensagem.recebida',
  /** AC-02 de MOD-NOTIF-10: reclamação de spam revoga o marketing daquele canal. */
  'mensagem.reclamada',
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

/**
 * Um termo foi aceito (MOD-DOC-07 e 08).
 *
 * É irmão de `tutor.consentimento.concedido` e não substituto dele: o consentimento diz
 * que o tutor autorizou, e este diz **qual texto** ele viu e que papel foi arquivado.
 * Quem escuta é o MOD-NOTIF, que manda o PDF ao tutor, e a auditoria.
 *
 * `documentId` é nulo no aceite de `TERMS`, que não arquiva papel.
 */
export interface TutorTermoAceitoEvent extends BaseEvent {
  tenantId: string
  tutorId: string
  kind: TermKind
  version: string
  documentId: string | null
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
  /**
   * O desvínculo do Portal sai daqui, e não do `portal-bff`: quem o provoca é a equipe,
   * pela ficha, com `tutor:update`. O evento gêmeo `tutor.portal_vinculado` fica no
   * mapa do MOD-PORTAL, porque é o BFF quem o publica — o corte segue quem escreve.
   */
  'tutor.portal_desvinculado': TutorPortalDesvinculadoEvent
  'tutor.criado': TutorCriadoEvent
  'tutor.atualizado': TutorAtualizadoEvent
  'tutor.inativado': TutorInativadoEvent
  'tutor.consentimento.concedido': TutorConsentimentoEvent
  'tutor.consentimento.revogado': TutorConsentimentoEvent
  'tutor.mesclado': TutorMescladoEvent
  'tutor.anonimizado': TutorAnonimizadoEvent
  'tutor.tag.aplicada': TutorTagEvent
  'tutor.tag.removida': TutorTagEvent
  'tutor.termo.aceito': TutorTermoAceitoEvent
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
  prescricaoEmitida: 'prescricao.emitida',
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

/**
 * Um receituário foi emitido (MOD-DOC-04).
 *
 * O nome já estava previsto no §8 do `prontuario_04`, apontando para um
 * `document-service` que não nasce: o consumidor mudou, o evento não. Quem escuta é o
 * MOD-NOTIF, que manda o PDF anexo ao tutor, e a auditoria.
 *
 * O payload leva o `documentId` e **não** o conteúdo: posologia é sigilo profissional,
 * e um evento é a última coisa que se quer ver num log de broker.
 */
export interface PrescricaoEmitidaEvent extends BaseEvent {
  tenantId: string
  prescriptionId: string
  documentId: string
  number: string
  petId: string
  tutorId: string
  vetId: string
}

export interface RecordEventMap {
  'prontuario.alerta.alterado': ProntuarioAlertaAlteradoEvent
  'atendimento.anulado': AtendimentoAnuladoEvent
  'prescricao.emitida': PrescricaoEmitidaEvent
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
  /**
   * O registro em `documents`, que é o dono do arquivo desde o MOD-DOC-02.
   *
   * Acrescentado pelo MOD-NOTIF-06: quem entrega o recibo por e-mail precisa do
   * documento para anexá-lo, e resolvê-lo do `receiptId` obrigaria o consumidor a ler
   * uma tabela do financeiro para descobrir uma chave que o publicador já tinha na mão.
   * Opcional no tipo por causa do parque em trânsito no dia do deploy.
   */
  documentId?: string | null
  /** Já formatado em reais pelo publicador — o template não faz conta. */
  amount?: string | null
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

// ─── MOD-TAXI ────────────────────────────────────────────────────────────────
// PRD taxi_dog_07 §8.

export const TAXI_ROUTING_KEYS = {
  taxiSolicitado: 'taxi.solicitado',
  taxiAtribuido: 'taxi.atribuido',
  taxiACaminho: 'taxi.a_caminho',
  taxiChegou: 'taxi.chegou',
  taxiColetado: 'taxi.coletado',
  taxiEntregue: 'taxi.entregue',
  taxiFalhou: 'taxi.falhou',
  taxiCancelado: 'taxi.cancelado',
} as const

export type TaxiRoutingKey = (typeof TAXI_ROUTING_KEYS)[keyof typeof TAXI_ROUTING_KEYS]

/**
 * Todo evento do Taxi Dog carrega `notify`.
 *
 * O módulo **relata**; quem decide falar com o tutor é o MOD-CRM. Mas nem toda
 * transição merece mensagem: remanejo interno de motorista e cancelamento por óbito
 * publicam com `notify: false` (AC-02 e AC-03 de MOD-TAXI-08). Sem esse campo, o CRM
 * teria de reimplementar a regra a partir do status — e a política moraria em dois
 * lugares que divergiriam na primeira mudança.
 */
interface TaxiBaseEvent extends BaseEvent {
  tenantId: string
  rideId: string
  notify: boolean
}

export interface TaxiSolicitadoEvent extends TaxiBaseEvent {
  appointmentId: string
  petId: string
  tutorId: string
  leg: 'PICKUP' | 'DROPOFF'
  windowStartsAt: string
  windowEndsAt: string
  priceCents: number
}

export interface TaxiAtribuidoEvent extends TaxiBaseEvent {
  driverId: string
  vehicleId: string | null
  /** Quem estava com a corrida antes — a primeira pergunta quando algo dá errado. */
  previousDriverId: string | null
}

export interface TaxiExecucaoEvent extends TaxiBaseEvent {
  appointmentId: string
  petId: string
  tutorId: string
  leg: 'PICKUP' | 'DROPOFF'
  driverId: string | null
  /** Hora informada pelo motorista (RN-20), que pode ser retroativa. */
  occurredAt: string
}

export interface TaxiFalhouEvent extends TaxiBaseEvent {
  appointmentId: string
  tutorId: string
  reason: string
  occurredAt: string
}

export interface TaxiCanceladoEvent extends TaxiBaseEvent {
  appointmentId: string
  tutorId: string
  reason: string
  /** AC-03 de MOD-TAXI-05: se o item de cobrança saiu do agendamento. */
  chargeRemoved: boolean
}

export interface TaxiEventMap {
  'taxi.solicitado': TaxiSolicitadoEvent
  'taxi.atribuido': TaxiAtribuidoEvent
  'taxi.a_caminho': TaxiExecucaoEvent
  'taxi.chegou': TaxiExecucaoEvent
  'taxi.coletado': TaxiExecucaoEvent
  'taxi.entregue': TaxiExecucaoEvent
  'taxi.falhou': TaxiFalhouEvent
  'taxi.cancelado': TaxiCanceladoEvent
}

// ─── MOD-CRM ─────────────────────────────────────────────────────────────────

/**
 * Eventos do relacionamento (PRD relacionamento_crm_08 §8).
 *
 * O módulo consome muito e publica pouco: o que sai daqui é o que o painel, a
 * auditoria e — depois — o MOD-ADMIN precisam para saber se o petshop está mesmo
 * falando com os clientes. Nenhum deles carrega o corpo da mensagem: o texto tem
 * nome, pet, horário e valor devido, e um evento é a coisa mais copiada do sistema.
 */

interface MessagingBaseEvent {
  timestamp: string
  tenantId: string
  messageId: string
  /**
   * Quem recebeu. **Nulável desde o MOD-NOTIF-01**: a mensagem pode ser dirigida a um
   * membro da equipe, e nesse caso quem está preenchido é `userId`.
   *
   * Os campos são opcionais no tipo para que os consumidores anteriores ao MOD-NOTIF
   * continuem compilando — o que eles precisam saber, todos, é se há tutor do outro
   * lado, e `tutorId` nulo responde isso.
   */
  tutorId?: string | null
  userId?: string | null
  recipientKind?: 'TUTOR' | 'USER'
}

export interface MensagemEnfileiradaEvent extends MessagingBaseEvent {
  channel: 'WHATSAPP' | 'EMAIL'
  category: 'TRANSACTIONAL' | 'OPERATIONAL' | 'MARKETING'
  templateKey: string
  scheduledFor: string | null
}

export interface MensagemEnviadaEvent extends MessagingBaseEvent {
  channel: 'WHATSAPP' | 'EMAIL'
  providerMessageId: string | null
  sentAt: string
  /**
   * O documento que viajou nesta mensagem, se houve (MOD-NOTIF-06).
   *
   * É por ele que o MOD-LEDGER fecha `receipts.sent_at` — o estado que o schema marcava
   * como inalcançável desde que a coluna nasceu. O ledger não pergunta "que mensagem é
   * essa?": ele procura o recibo cujo `document_id` casa, e ignora o resto.
   */
  documentId?: string | null
  templateKey?: string
}

export interface MensagemEntregueEvent extends MessagingBaseEvent {
  channel: 'WHATSAPP' | 'EMAIL'
  deliveredAt: string
  readAt: string | null
}

export interface MensagemFalhouEvent extends MessagingBaseEvent {
  channel: 'WHATSAPP' | 'EMAIL'
  errorCode: string | null
  attempts: number
}

export interface MensagemBloqueadaEvent extends MessagingBaseEvent {
  channel: 'WHATSAPP' | 'EMAIL'
  category: 'TRANSACTIONAL' | 'OPERATIONAL' | 'MARKETING'
  blockReason: string
}

/**
 * A conexão de WhatsApp do petshop mudou de estado (MOD-CRM-01).
 *
 * Publicado nas quedas e no bloqueio, não no pareamento: conectar é o admin agindo na
 * tela, e ele já viu o resultado. **Desconectar e ser banido acontecem sozinhos**, do
 * lado do provedor, e sem este evento o petshop descobriria por um cliente reclamando
 * que não recebeu. O destinatário é o MOD-ADMIN (AC-05).
 */
export interface WhatsappConexaoEvent extends BaseEvent {
  tenantId: string
  status: 'DISCONNECTED' | 'BANNED'
  phone: string | null
  detail: string | null
}

/**
 * O destinatário marcou o e-mail como spam (AC-02 de MOD-NOTIF-10).
 *
 * Existe como evento, e não como escrita direta, por causa de uma regra que o MOD-CRM
 * fixou e que continua valendo: **o messaging-service lê consentimento e nunca o
 * grava**. A trilha jurídica é `tutor_consents`, do MOD-TUTOR, append-only e com prova
 * — dois escritores dela seriam duas verdades sobre a mesma pergunta, e a que valeria
 * num processo seria a de lá.
 *
 * A supressão do endereço, essa, acontece na hora e do lado de cá: ela é técnica, é do
 * endereço, e não depende de o broker estar de pé.
 */
export interface MensagemReclamadaEvent extends MessagingBaseEvent {
  channel: 'WHATSAPP' | 'EMAIL'
}

export interface MessagingEventMap {
  'mensagem.enfileirada': MensagemEnfileiradaEvent
  'mensagem.reclamada': MensagemReclamadaEvent
  'mensagem.enviada': MensagemEnviadaEvent
  'mensagem.entregue': MensagemEntregueEvent
  'mensagem.falhou': MensagemFalhouEvent
  'mensagem.bloqueada': MensagemBloqueadaEvent
  'whatsapp.desconectado': WhatsappConexaoEvent
  'whatsapp.banido': WhatsappConexaoEvent
}

// ─── MOD-SITE ────────────────────────────────────────────────────────────────
// PRD site_tenant_10 §8.

export const SITE_ROUTING_KEYS = {
  sitePublicado: 'site.publicado',
  siteDespublicado: 'site.despublicado',
  leadRecebido: 'lead.recebido',
  leadConvertido: 'lead.convertido',
} as const

export type SiteRoutingKey = (typeof SITE_ROUTING_KEYS)[keyof typeof SITE_ROUTING_KEYS]

interface SiteBaseEvent extends BaseEvent {
  tenantId: string
  slug: string
}

export interface SitePublicacaoEvent extends SiteBaseEvent {
  actorId: string | null
}

/**
 * O aviso ao petshop **não** nasce daqui na v1.
 *
 * O evento é publicado desde já — audit e MOD-ADMIN o consomem —, mas nenhum
 * consumidor o transforma em mensagem: o messaging-service só sabe resolver
 * destinatário tutor, e destinatário interno (a equipe) é frente própria. Até lá, o
 * aviso é a fila em `/site/leads` e o contador de `NEW` no menu.
 */
export interface LeadRecebidoEvent extends SiteBaseEvent {
  leadId: string
  isExistingCustomer: boolean
}

export interface LeadConvertidoEvent extends SiteBaseEvent {
  leadId: string
  tutorId: string
  actorId: string | null
}

export interface SiteEventMap {
  'site.publicado': SitePublicacaoEvent
  'site.despublicado': SitePublicacaoEvent
  'lead.recebido': LeadRecebidoEvent
  'lead.convertido': LeadConvertidoEvent
}

// ─── MOD-PORTAL ──────────────────────────────────────────────────────────────

interface PortalBaseEvent extends BaseEvent {
  tenantId: string
  tutorId: string
}

/**
 * O vínculo nasceu: esta ficha passou a ter dono do lado de fora do balcão.
 *
 * Consumido pelo CRM (boas-vindas) e pela trilha. O `channel` diz por onde o código
 * chegou, e é o que responde depois se vale a pena continuar mandando WhatsApp para
 * quem já usa o Portal.
 */
export interface TutorPortalVinculadoEvent extends PortalBaseEvent {
  userId: string
  channel: 'EMAIL' | 'WHATSAPP'
}

/**
 * O vínculo foi desfeito pela equipe, ou pela anonimização da ficha.
 *
 * Consumido pelo gateway, que descarta o cache da sessão do Portal — é o que faz o
 * AC-05 de MOD-PORTAL-02 valer antes de o TTL de 60s vencer.
 */
export interface TutorPortalDesvinculadoEvent extends PortalBaseEvent {
  reason: 'EQUIPE' | 'ANONIMIZACAO'
  actorId: string | null
}

/**
 * O padrão que interessa não é a tentativa, é a série delas.
 *
 * Não carrega o identificador em claro, só o hash: um evento que dissesse "fulano@
 * tentou entrar" seria, ele próprio, o vazamento que o módulo inteiro evita.
 */
export interface PortalAcessoSuspeitoEvent extends BaseEvent {
  tenantId: string
  identifierHash: string
  ip: string | null
  attempts: number
}

export interface PortalEventMap {
  'tutor.portal_vinculado': TutorPortalVinculadoEvent
  'tutor.portal_desvinculado': TutorPortalDesvinculadoEvent
  'portal.acesso_suspeito': PortalAcessoSuspeitoEvent
}

// ─── MOD-ADMIN — administração da plataforma ─────────────────────────────────

/**
 * O suporte pediu acesso ao dado de um estabelecimento (MOD-ADMIN-02).
 *
 * `reason` viaja no evento porque é o que o administrador do petshop **lê para decidir**:
 * uma notificação que só diz "alguém pediu acesso" não dá base para aprovar nem para
 * recusar. É o único evento do sistema em que o texto livre é o conteúdo, e não metadado.
 */
export interface SuporteAcessoSolicitadoEvent extends BaseEvent {
  tenantId: string
  grantId: string
  reason: string
  requestedBy: string
}

export interface SuporteAcessoConcedidoEvent extends BaseEvent {
  tenantId: string
  grantId: string
  expiresAt: string
}

export interface SuporteAcessoDecididoEvent extends BaseEvent {
  tenantId: string
  grantId: string
}

/**
 * Uma regra de alerta passou a valer (MOD-ADMIN-06).
 *
 * **O evento é registro, não é o aviso.** Quem avisa é o e-mail direto, fora da fila —
 * um alarme que usa o RabbitMQ para dizer que o RabbitMQ caiu não é alarme (RN-10). Este
 * evento existe para quem quiser reagir a alertas de forma assíncrona, e some junto com o
 * broker sem levar o aviso consigo.
 */
export interface PlataformaAlertaDisparadoEvent extends BaseEvent {
  rule: string
  /** Nulo quando o alerta é da plataforma, e não de um estabelecimento. */
  tenantId: string | null
  value: number
  firedAt: string
}

export interface AdminEventMap {
  'suporte.acesso.solicitado': SuporteAcessoSolicitadoEvent
  'suporte.acesso.concedido': SuporteAcessoConcedidoEvent
  'suporte.acesso.negado': SuporteAcessoDecididoEvent
  'suporte.acesso.revogado': SuporteAcessoDecididoEvent
  'plataforma.alerta.disparado': PlataformaAlertaDisparadoEvent
}

// ─── MOD-AI ──────────────────────────────────────────────────────────────────
// PRD agentes_ia_15 §8.

export const AGENT_ROUTING_KEYS = {
  mensagemRecebida: 'agente.mensagem.recebida',
  handoff: 'agente.handoff',
  conversaEncerrada: 'agente.conversa.encerrada',
  agendamentoCriado: 'agente.agendamento.criado',
} as const

export type AgentRoutingKey = (typeof AGENT_ROUTING_KEYS)[keyof typeof AGENT_ROUTING_KEYS]

interface AgentBaseEvent extends BaseEvent {
  tenantId: string
  conversationId: string
}

/**
 * Chegou mensagem de cliente — o primeiro evento do produto que nasce de fora para
 * dentro.
 *
 * Todos os outros contam o que **nós** fizemos: enfileiramos, enviamos, cobramos. Este
 * conta o que o cliente fez, e por isso vai sem conteúdo: o corpo da mensagem é dado
 * pessoal cifrado com a DEK do tenant, e um evento que o carregasse o publicaria em claro
 * numa fila que ninguém cifra.
 */
export interface AgenteMensagemRecebidaEvent extends AgentBaseEvent {
  /** Nulo quando o número não tem ficha, que é o AC-02 de MOD-AI-01. */
  tutorId: string | null
}

/** A conversa passou para gente, e o motivo é o que a fila da recepção exibe. */
export interface AgenteHandoffEvent extends AgentBaseEvent {
  reason: string
}

export interface AgenteConversaEncerradaEvent extends AgentBaseEvent {
  turns: number
  costCents: number
  /** Resolvida é a que terminou **sem** passar por gente (AC-02 de MOD-AI-09). */
  resolved: boolean
}

/**
 * O agente marcou um horário, e o tutor confirmou antes (MOD-AI-04).
 *
 * **Não substitui os eventos do MOD-AGENDA**: o agendamento nasce pela mesma função que
 * o Portal chama, e os eventos de domínio saem de lá como sempre. Este conta a outra
 * metade da história — que quem pediu foi uma conversa de WhatsApp, e qual foi ela.
 *
 * Sai só na criação, como o §8 do PRD o descreve. Cancelar e remarcar deixam a mesma
 * marca onde ela é procurada de verdade: na trilha de auditoria, com o `conversation_id`
 * no `after`.
 */
export interface AgenteAgendamentoCriadoEvent extends AgentBaseEvent {
  appointmentId: string
}

export interface AgentEventMap {
  'agente.mensagem.recebida': AgenteMensagemRecebidaEvent
  'agente.handoff': AgenteHandoffEvent
  'agente.conversa.encerrada': AgenteConversaEncerradaEvent
  'agente.agendamento.criado': AgenteAgendamentoCriadoEvent
}
