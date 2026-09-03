import { z } from 'zod'
import { SITE_VISIBLE_TENANT_STATUSES } from './site.js'

/**
 * MOD-PORTAL — o contrato da superfície do tutor (PRD portal_tutor_09 §5).
 *
 * O Portal é a única tela do sistema em que quem entra é o **cliente final**, e não a
 * equipe do petshop. Tudo aqui é escrito com isso em mente: nada revela se uma pessoa é
 * cliente do estabelecimento, e nenhum campo que define preço aceita edição.
 */

/**
 * O namespace do HMAC que identifica **a tentativa**, não a ficha.
 *
 * É separado de `TUTOR_PHONE_HASH_NAMESPACE` e `TUTOR_EMAIL_HASH_NAMESPACE` de
 * propósito: aqueles procuram o tutor; este só conta tentativas por identificador,
 * inclusive de identificador que não corresponde a ficha nenhuma. Reusar o namespace da
 * ficha faria a tabela de desafios virar um índice de "quem é cliente daqui" — o
 * contrário exato do que o módulo defende.
 */
export const PORTAL_IDENTIFIER_HASH_NAMESPACE = 'portal:identifier'

/** Validade do código de verificação (AC-01 de MOD-PORTAL-01). */
export const PORTAL_CHALLENGE_TTL_MIN = 10

/**
 * Tentativas antes de o desafio ser invalidado (AC-05).
 *
 * Seis dígitos são 10⁶ combinações; sem teto, um script acerta em minutos.
 */
export const PORTAL_MAX_ATTEMPTS = 5

/** Espera imposta ao identificador depois de esgotar as tentativas. */
export const PORTAL_COOLDOWN_MIN = 15

/** Teto de pedidos de código, por identificador e por IP, em janelas distintas. */
export const PORTAL_CHALLENGE_RATE = {
  perIdentifier: { max: 3, windowMin: 15 },
  perIp: { max: 10, windowMin: 15 },
} as const

/**
 * Piso de tempo de resposta do desafio (AC-03 de MOD-PORTAL-11).
 *
 * A busca por ficha existente é mais rápida que a inexistente, e a resposta idêntica do
 * AC-03 de MOD-PORTAL-01 é derrotada por cronômetro sem isto. O número é folgado o
 * bastante para cobrir a diferença e curto o bastante para não parecer travamento.
 */
export const PORTAL_CHALLENGE_MIN_MS = 700

export const PortalChannelSchema = z.enum(['EMAIL', 'WHATSAPP'])
export type PortalChannel = z.infer<typeof PortalChannelSchema>

/**
 * MOD-PORTAL-01. O identificador é e-mail **ou** telefone; o canal decorre dele.
 *
 * `website` é o honeypot: campo oculto no formulário, com nome inócuo, que gente nunca
 * preenche e robô preenche sempre. Vindo preenchido, a resposta é a mesma do sucesso —
 * responder com erro ensinaria o bot a contornar (AC-02 de MOD-PORTAL-11).
 *
 * **Daí o campo aceitar texto em vez de exigir vazio**, divergindo do §5 do PRD, que o
 * escreveu como `z.string().max(0)`. Um `max(0)` recusaria no schema, e a recusa é um
 * 422 — que é exatamente a resposta diferente que o AC-02 proíbe. Quem decide o que
 * fazer com o campo preenchido é o handler, e o que ele faz é nada.
 */
export const PortalChallengeSchema = z
  .object({
    identifier: z.string().trim().min(5).max(120),
    website: z.string().max(200).optional(),
  })
  .strict()
export type PortalChallengeInput = z.output<typeof PortalChallengeSchema>

export const PortalVerifySchema = z
  .object({
    challengeId: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict()
export type PortalVerifyInput = z.output<typeof PortalVerifySchema>

/**
 * A resposta do desafio. **Sempre a mesma forma e os mesmos campos preenchidos**, tenha
 * casado ou não com uma ficha.
 *
 * `maskedTarget` é calculado a partir do que a pessoa **digitou**, e não do que está
 * gravado na ficha. A diferença é o ponto todo: mascarar o dado do banco produziria
 * `null` para quem não é cliente e um valor para quem é — a resposta uniforme derrotada
 * por um campo. Mascarar a entrada não revela nada, porque quem a leu foi quem a
 * escreveu.
 */
export const PortalChallengeResponseSchema = z.object({
  challengeId: z.uuid(),
  channel: PortalChannelSchema,
  maskedTarget: z.string(),
  expiresInMin: z.number().int(),
})
export type PortalChallengeResponse = z.infer<typeof PortalChallengeResponseSchema>

/**
 * O contexto inicial do Portal — o que `GET /portal/v1/me` devolve.
 *
 * `features` existe porque desligar agendamento online **não** é desligar o Portal
 * (RN-15): são duas chaves independentes, e a tela precisa das duas para saber o que
 * mostrar.
 */
export const PortalContextResponseSchema = z.object({
  tutor: z.object({
    id: z.uuid(),
    name: z.string(),
    balanceCents: z.number().int(),
    petsCount: z.number().int(),
  }),
  tenant: z.object({
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
  }),
  features: z.object({
    portalEnabled: z.boolean(),
    onlineBookingEnabled: z.boolean(),
    onlineBookingRequiresApproval: z.boolean(),
    taxiEnabled: z.boolean(),
  }),
})
export type PortalContextResponse = z.infer<typeof PortalContextResponseSchema>

/** A identidade visual que a tela de login mostra antes de haver sessão. */
export const PortalTenantResponseSchema = z.object({
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  brandColor: z.string().nullable(),
  portalEnabled: z.boolean(),
})
export type PortalTenantResponse = z.infer<typeof PortalTenantResponseSchema>

/** Os textos que o Portal manda pelo messaging-service. */
export const PORTAL_TEMPLATE_KEYS = {
  accessCode: 'portal_codigo_acesso',
  welcome: 'portal_boas_vindas',
} as const

/**
 * Mascaramento do destino, para a tela dizer para onde o código foi sem revelar o
 * contato inteiro a quem só adivinhou o identificador.
 */
export function maskPortalTarget(identifier: string, channel: PortalChannel): string {
  if (channel === 'EMAIL') {
    const [user = '', domain = ''] = identifier.split('@')
    const head = user.slice(0, 1)
    return `${head}${'*'.repeat(Math.max(user.length - 1, 1))}@${domain}`
  }

  const digits = identifier.replace(/\D/g, '')
  const tail = digits.slice(-4)
  return `(${digits.slice(-11, -9) || '..'}) *****-${tail}`
}

/** E-mail ou telefone? A escolha do canal decorre disto, e não de um seletor na tela. */
export function portalChannelOf(identifier: string): PortalChannel {
  return identifier.includes('@') ? 'EMAIL' : 'WHATSAPP'
}

/**
 * Estados de tenant em que o Portal ainda atende.
 *
 * É **a mesma lista** do site público, e o alias existe para que continue sendo: as
 * duas são superfícies de cliente, e um petshop cuja conta parou não deve servir nenhuma
 * das duas. Duplicar os três nomes faria uma envelhecer sem a outra, e o sintoma seria
 * um Portal no ar para quem já não é cliente do produto.
 */
export const PORTAL_VISIBLE_TENANT_STATUSES = SITE_VISIBLE_TENANT_STATUSES

export function isPortalVisibleStatus(status: string): boolean {
  return (PORTAL_VISIBLE_TENANT_STATUSES as readonly string[]).includes(status)
}

// ─── MOD-PORTAL-03 — Meus Pets ───────────────────────────────────────────────

/**
 * O schema é a trava (AC-03 de MOD-PORTAL-03).
 *
 * Peso, porte, raça e pelagem **não estão aqui**, e é por isso que a recusa acontece
 * antes de qualquer checagem no handler: o campo simplesmente não é aceito. Os quatro
 * entram no cálculo de duração e de preço do serviço (MOD-AGENDA), e um tutor que
 * corrige o porte na véspera do banho muda quanto vai pagar — é cláusula comercial, não
 * dado cadastral.
 *
 * **Divergência do §5 do PRD:** `emergencyContact` está lá e não está aqui, porque a
 * coluna não existe em `pets` — nem no MOD-PET, que é quem define a ficha. Aceitar o
 * campo obrigaria a inventar onde guardá-lo, e o Portal não é o lugar de estender o
 * modelo do pet. O contato de emergência do tutor é `phone_alt`, e vive no MOD-PORTAL-09.
 */
export const UpdateOwnPetSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    /**
     * `null` apaga a data. É diferente de omitir o campo, e a diferença importa: quem
     * cadastrou uma data errada precisa poder voltar ao "não sei".
     */
    birthDate: z.iso.date().nullable().optional(),
    neutered: z.boolean().nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
export type UpdateOwnPetInput = z.output<typeof UpdateOwnPetSchema>

/** Os campos que o tutor vê e não edita, para a tela poder dizer isso em vez de escondê-los. */
export const PORTAL_PET_LOCKED_FIELDS = ['weightKg', 'size', 'breed', 'coat'] as const

/**
 * Alerta clínico visível ao tutor.
 *
 * Alergia e alerta médico entram; **temperamento não** (AC-04 de MOD-PORTAL-04).
 * "Reativo com estranhos" é anotação operacional da equipe, e devolvê-la ao dono do
 * animal por uma tela sem contexto é conflito garantido no balcão.
 */
export const PortalPetAlertSchema = z.object({
  kind: z.enum(['ALLERGY', 'MEDICAL']),
  label: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
})
export type PortalPetAlert = z.infer<typeof PortalPetAlertSchema>

export const PortalNextAppointmentSchema = z.object({
  id: z.uuid(),
  startsAt: z.string(),
  status: z.string(),
  services: z.array(z.string()),
})
export type PortalNextAppointment = z.infer<typeof PortalNextAppointmentSchema>

export const PortalPetSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  species: z.string(),
  breed: z.string().nullable(),
  ageLabel: z.string().nullable(),
  photoUrl: z.string().nullable(),
  /**
   * O pet falecido continua na lista, numa seção "em memória", somente leitura e sem
   * botão de agendar (AC-05 de MOD-PORTAL-03). O transferido some — mas isso não é um
   * estado desta resposta: ele sai porque o vínculo terminou.
   */
  inMemoriam: z.boolean(),
  lastAttendanceAt: z.string().nullable(),
  nextAppointment: PortalNextAppointmentSchema.nullable(),
})
export type PortalPetSummary = z.infer<typeof PortalPetSummarySchema>

export const PortalPetDetailSchema = PortalPetSummarySchema.extend({
  sex: z.enum(['MALE', 'FEMALE', 'UNKNOWN']),
  birthDate: z.string().nullable(),
  birthDatePrecision: z.enum(['EXACT', 'ESTIMATED', 'UNKNOWN']),
  neutered: z.boolean().nullable(),
  notes: z.string().nullable(),
  color: z.string().nullable(),
  /** Os quatro do `PORTAL_PET_LOCKED_FIELDS`, já em rótulo de tela. */
  weightKg: z.number().nullable(),
  size: z.string(),
  coat: z.string().nullable(),
  alerts: z.array(PortalPetAlertSchema),
})
export type PortalPetDetail = z.infer<typeof PortalPetDetailSchema>

// ─── MOD-PORTAL-04 — Histórico do Pet ────────────────────────────────────────

/**
 * Uma linha da história do pet, do ponto de vista de quem é dono dele.
 *
 * `voidedAt` preenchido é o atendimento anulado, que **aparece** (AC-03): o tutor viu o
 * pet ir ao petshop naquele dia, e uma linha do tempo que nega isso destrói a confiança
 * na tela inteira. O motivo interno da anulação, esse não vem.
 *
 * `notes` traz só o que foi marcado `TUTOR_VISIBLE`, e a exclusão é na consulta — não é
 * omissão no front (AC-02).
 */
export const PortalTimelineEntrySchema = z.object({
  id: z.uuid(),
  type: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  professional: z.string().nullable(),
  services: z.array(z.string()),
  notes: z.array(z.string()),
  photoUrls: z.array(z.string()),
  weightKg: z.number().nullable(),
  voidedAt: z.string().nullable(),
})
export type PortalTimelineEntry = z.infer<typeof PortalTimelineEntrySchema>

export const PortalTimelineResponseSchema = z.object({
  entries: z.array(PortalTimelineEntrySchema),
  nextCursor: z.string().nullable(),
})
export type PortalTimelineResponse = z.infer<typeof PortalTimelineResponseSchema>

export const PortalTimelineQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
export type PortalTimelineQuery = z.output<typeof PortalTimelineQuerySchema>
