import { z } from 'zod'
import { SITE_VISIBLE_TENANT_STATUSES } from './site.js'
import { CEPSchema, UFSchema } from './tutor.js'
import { TaxiLegSchema, TaxiRideStatusSchema } from './taxi.js'

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
  /**
   * MOD-PORTAL-09, AC-02 — o código que confirma um contato **novo**.
   *
   * Texto próprio, e não o do acesso: este código sai para um endereço que ainda não
   * está na ficha, e quem o recebe pode não ter pedido nada. "Seu código de acesso"
   * chegando a um número alheio não explica nada a quem o lê; dizer que alguém tentou
   * cadastrar aquele contato no petshop, sim.
   */
  contactCode: 'portal_codigo_contato',
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

// ─── MOD-PORTAL-05 — Agendamento Online ──────────────────────────────────────

/**
 * Um serviço que o tutor pode marcar, já com o preço **deste** pet.
 *
 * O preço vem junto do cardápio, e não depois da escolha, por decisão de produto de
 * 2026-08-28: agendar sem saber quanto custa faz o tutor ligar para perguntar, e a
 * ligação anula o autoatendimento que justifica o módulo.
 *
 * Serviço sem preço cadastrado para o porte do pet **não aparece**. A alternativa
 * seria oferecê-lo e recusar na confirmação, que é levar alguém até o fim de um
 * caminho sem saída.
 */
export const PortalBookableServiceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  priceCents: z.number().int(),
  durationMin: z.number().int(),
})
export type PortalBookableService = z.infer<typeof PortalBookableServiceSchema>

export const PortalBookingServicesResponseSchema = z.object({
  petName: z.string(),
  services: z.array(PortalBookableServiceSchema),
})
export type PortalBookingServicesResponse = z.infer<
  typeof PortalBookingServicesResponseSchema
>

/**
 * A consulta de horários.
 *
 * `serviceIds` separado por vírgula, como na rota do domínio que responde por baixo —
 * o BFF repassa a pergunta em vez de recalcular a grade, e é isso que garante o AC-01:
 * o tutor vê os mesmos horários que a recepção veria.
 */
export const PortalAvailabilityQuerySchema = z
  .object({
    petId: z.uuid(),
    serviceIds: z
      .string()
      .transform((raw) => raw.split(',').map((id) => id.trim()).filter(Boolean))
      .pipe(z.array(z.uuid()).min(1).max(10)),
    /** Dia no fuso do petshop (`YYYY-MM-DD`), e não um instante: quem escolhe é o dia. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
export type PortalAvailabilityQuery = z.output<typeof PortalAvailabilityQuerySchema>

export const PortalSlotSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  professionalId: z.uuid(),
  professionalName: z.string(),
})
export type PortalSlot = z.infer<typeof PortalSlotSchema>

export const PortalAvailabilityResponseSchema = z.object({
  slots: z.array(PortalSlotSchema),
  /** AC-02 do MOD-AGENDA-11: dia vazio sem alternativa devolve o tutor ao telefone. */
  nextAvailable: z.string().nullable(),
  durationMin: z.number().int(),
  priceCents: z.number().int(),
  timezone: z.string(),
  /**
   * RN-07: a antecedência mínima do tenant, para a tela **não oferecer** o que o POST
   * recusaria. O filtro acontece no BFF; o número vem junto para a tela poder explicar
   * por que o começo do dia sumiu.
   */
  minNoticeHours: z.number().int(),
})
export type PortalAvailabilityResponse = z.infer<typeof PortalAvailabilityResponseSchema>

// ─── MOD-PORTAL-07 — Taxi Dog no Agendamento ─────────────────────────────────

/**
 * O leva-e-traz pedido **junto** do agendamento (decisão de produto de 2026-08-28,
 * respondendo à questão 3 de `taxi_dog_07.md`).
 *
 * Não existe pedido de corrida solto no Portal, e a razão é estrutural: no MOD-TAXI o
 * dono da corrida é o agendamento (RN-01). Uma segunda porta criaria uma segunda fila de
 * aprovação além da que o agendamento online já pode ter, e o tutor ficaria esperando
 * duas confirmações para uma tarde só.
 *
 * Ida e volta são **duas linhas** em `taxi_rides` (RN-02 do MOD-TAXI), e por isso duas
 * caixas independentes: quem leva o pet e quer que o petshop o traga de volta é caso
 * comum, e o contrário também.
 */
export const PortalBookingTaxiSchema = z
  .object({
    pickup: z.boolean().default(false),
    dropoff: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.pickup || value.dropoff, {
    message: 'Escolha ao menos uma perna do leva-e-traz',
  })
export type PortalBookingTaxi = z.output<typeof PortalBookingTaxiSchema>

/**
 * Por que o leva-e-traz **não** está disponível para este tutor.
 *
 * O motivo viaja como enum e não só como frase porque a tela reage diferente a cada um:
 * endereço faltando é algo que o tutor resolve (e a mensagem manda falar com a equipe,
 * enquanto MOD-PORTAL-09 não existe), fora de área é definitivo para aquele endereço, e
 * `UNAVAILABLE` é o taxidog-service fora do ar — que volta sozinho.
 */
export const PORTAL_TAXI_UNAVAILABLE_REASONS = [
  'DISABLED',
  'NO_ADDRESS',
  'OUT_OF_AREA',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
] as const
export const PortalTaxiUnavailableReasonSchema = z.enum(PORTAL_TAXI_UNAVAILABLE_REASONS)
export type PortalTaxiUnavailableReason = z.infer<typeof PortalTaxiUnavailableReasonSchema>

/**
 * AC-02 — quanto custa buscar aqui, **antes** de a corrida existir.
 *
 * A oferta sai de `GET /v1/taxi/quote`, que o MOD-TAXI criou justamente para isto: um
 * POST que criasse a corrida para descobrir o preço deixaria lixo no painel do petshop a
 * cada pergunta do tutor.
 *
 * O preço é **por perna**. Somar as duas aqui esconderia que quem pede só a ida paga
 * metade, e a tela precisa dos dois números para montar as duas caixas.
 *
 * `address` é o endereço primário do tutor, exibido inteiro de propósito: é para lá que
 * o motorista vai, e a última chance de alguém notar que a família se mudou é agora.
 */
export const PortalTaxiOfferSchema = z.object({
  available: z.boolean(),
  reason: PortalTaxiUnavailableReasonSchema.nullable(),
  /** A frase já escrita para o tutor. Nula quando o leva-e-traz está disponível. */
  message: z.string().nullable(),
  address: z
    .object({
      label: z.string(),
      zipCode: z.string(),
    })
    .nullable(),
  priceCentsPerLeg: z.number().int().nullable(),
  /** A janela prometida, em minutos, para a tela dizer "buscamos até uma hora antes". */
  windowMinutes: z.number().int(),
})
export type PortalTaxiOffer = z.infer<typeof PortalTaxiOfferSchema>

/**
 * Uma corrida, como o tutor a vê (AC-05).
 *
 * **Sem mapa, sem posição do veículo e sem o nome do motorista.** O rastreamento por GPS
 * é a questão 7 do MOD-TAXI e está fora da v1; o nome de quem dirige é dado de um
 * trabalhador exibido a um cliente, e não muda nada do que o tutor faz a seguir. O que
 * resolve a ansiedade de quem espera é o status e a janela, e são esses que descem.
 *
 * `statusText` vem pronto do servidor, por `taxiStatusTutorText`: o rótulo do painel é
 * escrito para a operação, e "Sem motorista" no celular do tutor lê como falha.
 */
export const PortalTaxiRideSchema = z.object({
  id: z.uuid(),
  leg: TaxiLegSchema,
  legLabel: z.string(),
  status: TaxiRideStatusSchema,
  statusText: z.string(),
  windowStartsAt: z.string(),
  windowEndsAt: z.string(),
  priceCents: z.number().int(),
})
export type PortalTaxiRide = z.infer<typeof PortalTaxiRideSchema>

/**
 * O pedido de agendamento (MOD-PORTAL-05).
 *
 * **Diverge do §5 do PRD em dois pontos, conscientemente.**
 *
 * `professionalId` é obrigatório, e no PRD é opcional: o horário que o tutor tocou já
 * nomeia quem atende — cada vaga da grade é de um profissional. Aceitá-lo ausente
 * obrigaria o BFF a escolher alguém, e escolher por conta própria é como se marca o
 * banho na pessoa errada.
 *
 * `idempotencyKey` **não existe aqui**. O que protege do duplo toque é o próprio
 * pedido: agendamento do mesmo pet, no mesmo instante e ainda em pé devolve o que já
 * existe em vez de criar o segundo. Uma chave que ninguém guarda seria teatro, e
 * guardá-la exigiria tabela para resolver o que a pergunta natural já resolve.
 *
 * `taxi` chegou na fatia 4 (MOD-PORTAL-07) e é **opcional**: o pedido sem ele é o
 * agendamento puro, e continua sendo o caminho da maioria.
 */
export const PortalBookingSchema = z
  .object({
    petId: z.uuid(),
    serviceIds: z.array(z.uuid()).min(1).max(10),
    startsAt: z.iso.datetime(),
    professionalId: z.uuid(),
    notes: z.string().trim().max(500).optional(),
    /** RN-09: o alerta clínico crítico que o tutor viu e confirmou. */
    acknowledgedAlerts: z.boolean().default(false),
    /** MOD-PORTAL-07: o leva-e-traz pedido junto, nunca como pedido solto. */
    taxi: PortalBookingTaxiSchema.optional(),
  })
  .strict()
export type PortalBookingInput = z.output<typeof PortalBookingSchema>

// ─── MOD-PORTAL-06 — Meus Agendamentos ───────────────────────────────────────

export const PortalAppointmentSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  petId: z.uuid(),
  petName: z.string(),
  professionalName: z.string(),
  services: z.array(z.string()),
  /** O preço congelado na criação (RN-04 do MOD-AGENDA), não a tabela de hoje. */
  totalCents: z.number().int(),
  /** `true` enquanto o petshop não decidiu a triagem do AC-06 de MOD-PORTAL-05. */
  awaitingApproval: z.boolean(),
  /**
   * As corridas de leva-e-traz deste agendamento (AC-05 de MOD-PORTAL-07).
   *
   * Vazio na esmagadora maioria dos casos, e sempre presente: uma lista opcional faria
   * cada tela testar `undefined` antes de percorrer, e a primeira que esquecesse
   * quebraria só na conta que tem taxi — que é justamente a que ninguém testa à mão.
   */
  taxi: z.array(PortalTaxiRideSchema).default([]),
})
export type PortalAppointment = z.infer<typeof PortalAppointmentSchema>

/**
 * O que o tutor pode fazer com **este** agendamento, respondido pelo servidor.
 *
 * A tela não recalcula janela de cancelamento nem lê estado para decidir o que
 * mostrar: a regra é do tenant e muda por configuração, e um botão que aparece quando
 * não deveria é pior do que botão nenhum.
 */
export const PortalAppointmentActionsSchema = z.object({
  canCancel: z.boolean(),
  canReschedule: z.boolean(),
  /** Cancelar agora cai fora da janela e gera taxa (AC-03). */
  cancelIsLate: z.boolean(),
  cancelFeeCents: z.number().int(),
  cancellationWindowHours: z.number().int(),
})
export type PortalAppointmentActions = z.infer<typeof PortalAppointmentActionsSchema>

export const PortalAppointmentDetailSchema = PortalAppointmentSchema.extend({
  source: z.string(),
  /**
   * Os serviços por id, e não só pelo rótulo.
   *
   * É o que a remarcação precisa: a grade do dia novo depende da duração do **mesmo**
   * conjunto, e reconstruí-lo a partir dos nomes exigiria casar texto com catálogo.
   */
  serviceIds: z.array(z.uuid()),
  cancelledAt: z.string().nullable(),
  cancelledLate: z.boolean().nullable(),
  actions: PortalAppointmentActionsSchema,
})
export type PortalAppointmentDetail = z.infer<typeof PortalAppointmentDetailSchema>

/**
 * Os próximos vêm com `actions`; os passados, não.
 *
 * Não é economia de bytes: o cartão do futuro tem botões e o do passado não tem, e uma
 * tela que decidisse sozinha quais mostrar precisaria conhecer a janela de cancelamento
 * do petshop — que é configuração e muda sem que ninguém publique front nenhum.
 *
 * `timezone` acompanha pelo RN-19: a hora exibida é a do estabelecimento, e não a do
 * aparelho de quem está olhando — o tutor viajando leria o horário errado.
 */
export const PortalUpcomingAppointmentSchema = PortalAppointmentSchema.extend({
  actions: PortalAppointmentActionsSchema,
})
export type PortalUpcomingAppointment = z.infer<typeof PortalUpcomingAppointmentSchema>

export const PortalAppointmentsResponseSchema = z.object({
  upcoming: z.array(PortalUpcomingAppointmentSchema),
  past: z.array(PortalAppointmentSchema),
  nextCursor: z.string().nullable(),
  timezone: z.string(),
})
export type PortalAppointmentsResponse = z.infer<typeof PortalAppointmentsResponseSchema>

export const PortalAppointmentsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
export type PortalAppointmentsQuery = z.output<typeof PortalAppointmentsQuerySchema>

/**
 * AC-03 de MOD-PORTAL-06 — cancelar fora da janela.
 *
 * `acknowledgeFee` é o mesmo desenho de `acknowledgedAlerts` no MOD-AGENDA: o servidor
 * recusa a primeira tentativa dizendo quanto custa, e a segunda passa. A consequência
 * é mostrada **antes**, e quem confirma é a pessoa, não a tela.
 */
export const PortalCancelSchema = z
  .object({
    acknowledgeFee: z.boolean().default(false),
  })
  .strict()
export type PortalCancelInput = z.output<typeof PortalCancelSchema>

export const PortalRescheduleSchema = z
  .object({
    startsAt: z.iso.datetime(),
    professionalId: z.uuid(),
  })
  .strict()
export type PortalRescheduleInput = z.output<typeof PortalRescheduleSchema>

// ─── MOD-PORTAL-08 — Extrato e Recibos ───────────────────────────────────────

/**
 * A convenção de sinal da plataforma, dita uma vez para quem escrever tela.
 *
 * **Negativo é dívida, positivo é crédito** (RN-02 do MOD-LEDGER, e a mesma de
 * `tutors.balance_cents`). Ela é contraintuitiva na leitura de quem monta a tela — a
 * tentação é ler "saldo maior que zero" como "deve" — e já produziu um cartão do Portal
 * dizendo "Sem pendências" a quem devia. As duas funções abaixo existem para que
 * nenhuma tela precise lembrar da regra.
 */
export function portalOwesCents(balanceCents: number): number {
  return balanceCents < 0 ? -balanceCents : 0
}

export function portalCreditCents(balanceCents: number): number {
  return balanceCents > 0 ? balanceCents : 0
}

/**
 * Um crédito de pacote ainda de pé (AC-04).
 *
 * `expiresAt` vem sempre, e não só quando está perto: a regra de que o crédito não
 * usado expira e **nada é devolvido** (RN-08 do MOD-LEDGER) precisa ser dita antes do
 * vencimento, e uma data que só aparece na última semana é aviso que chega tarde.
 */
export const PortalPackageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  petName: z.string().nullable(),
  creditsTotal: z.number().int(),
  creditsRemaining: z.number().int(),
  expiresAt: z.string(),
  /** Dentro da janela de aviso do tenant (`packageExpiryWarningDays`). */
  expiringSoon: z.boolean(),
})
export type PortalPackage = z.infer<typeof PortalPackageSchema>

/**
 * AC-05 — como pagar, já que não há botão de pagar.
 *
 * Não existe PSP na v1: fingir um checkout seria pior que a ausência dele. O que a tela
 * entrega é o caminho real, e ele só aparece quando o petshop configurou alguma coisa —
 * um bloco "Como pagar" vazio manda o tutor procurar o que não existe.
 */
export const PortalPaymentInstructionsSchema = z.object({
  pixKey: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  /** Grade de funcionamento, já resolvida em linhas prontas para exibição. */
  hours: z.array(z.object({ label: z.string(), value: z.string() })),
})
export type PortalPaymentInstructions = z.infer<typeof PortalPaymentInstructionsSchema>

export const PortalFinanceResponseSchema = z.object({
  /** Negativo = deve; positivo = tem crédito. Ver `portalOwesCents`. */
  balanceCents: z.number().int(),
  /** Soma dos débitos ainda não quitados. Zero para quem está em dia. */
  openDebitsCents: z.number().int(),
  /** O débito mais antigo em aberto, para a tela dizer "desde quando". */
  oldestOpenDebitAt: z.string().nullable(),
  packages: z.array(PortalPackageSchema),
  howToPay: PortalPaymentInstructionsSchema,
  timezone: z.string(),
})
export type PortalFinanceResponse = z.infer<typeof PortalFinanceResponseSchema>

/**
 * Uma linha do extrato.
 *
 * `internalNotes` **não existe neste tipo** (AC-02). O campo não é omitido na
 * serialização: ele nunca é consultado, como o temperamento do pet na fatia 2. Filtrar
 * na resposta significaria o texto ter saído do banco e atravessado o processo.
 *
 * `amountCents` já vem **com sinal** — crédito positivo, débito negativo —, para que a
 * tela não precise combinar `direction` com um valor absoluto e errar o sinal em uma
 * das duas listas.
 */
export const PortalStatementEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.string(),
  description: z.string(),
  amountCents: z.number().int(),
  category: z.string(),
  petName: z.string().nullable(),
  /** `true` quando o lançamento foi estornado. A tela risca a linha. */
  reversed: z.boolean(),
  /**
   * O pagamento que originou a linha, quando há um. É a chave do recibo (AC-03) — e
   * nula em tudo o mais, que é a forma de a tela não oferecer recibo de um débito.
   */
  paymentId: z.uuid().nullable(),
})
export type PortalStatementEntry = z.infer<typeof PortalStatementEntrySchema>

/**
 * Paginação por página, e não por cursor como no histórico do pet.
 *
 * O extrato ordena por `occurred_at`, que **repete** — três serviços do mesmo dia
 * lançados juntos têm o mesmo instante —, e um cursor por data ou pularia linhas ou as
 * repetiria. O total acompanha para a tela saber quando parar de oferecer "ver mais".
 */
export const PortalStatementQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
export type PortalStatementQuery = z.output<typeof PortalStatementQuerySchema>

export const PortalStatementResponseSchema = z.object({
  entries: z.array(PortalStatementEntrySchema),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  balanceCents: z.number().int(),
  timezone: z.string(),
})
export type PortalStatementResponse = z.infer<typeof PortalStatementResponseSchema>

/**
 * O recibo, como a tela o recebe (AC-03).
 *
 * `url` é assinada e de vida curta, e pode voltar nula: o PDF nasce depois do
 * pagamento, fora da transação, e um recibo ainda em preparo tem número mas não tem
 * arquivo. A tela diz "em preparo" em vez de oferecer um link morto.
 */
export const PortalReceiptResponseSchema = z.object({
  number: z.string(),
  status: z.string(),
  issuedAt: z.string().nullable(),
  url: z.string().nullable(),
})
export type PortalReceiptResponse = z.infer<typeof PortalReceiptResponseSchema>

// ─── MOD-PORTAL-10 — Central de Comunicação e Preferências ───────────────────

/**
 * Os únicos estados que o tutor vê (AC-02).
 *
 * A lista é curta e a razão de cada ausência é a mesma: **o tutor não é auditor da
 * fila do petshop**. `QUEUED`, `SCHEDULED` e `SENDING` são mensagens que ainda não
 * saíram — mostrá-las seria contar um lembrete antes de ele chegar. `FAILED` e `DEAD`
 * são erro do provedor, e ler "não conseguimos falar com você" numa tela que a pessoa
 * abriu justamente para ler o que o petshop mandou é ruído sobre um problema que não é
 * dela. `BLOCKED` é o pior de todos: exporia a régua interna, dizendo quantas vezes o
 * estabelecimento quis falar e a própria política o impediu.
 *
 * `MERGED` também fica de fora, e não é bloqueio: a mensagem **saiu**, dentro de outra
 * (RN-08 do MOD-CRM). Listá-la mostraria duas linhas para um texto que chegou uma vez.
 * A que absorveu está na lista, com o conteúdo inteiro.
 */
export const PORTAL_VISIBLE_MESSAGE_STATUSES = ['SENT', 'DELIVERED', 'READ'] as const

/**
 * O que nunca entra no histórico, mesmo tendo sido entregue.
 *
 * O código de acesso é credencial viva por dez minutos, e o Portal roda no celular de
 * família que passa de mão em mão — a mesma razão pela qual o "Sair" existe no Início.
 * Um código que ninguém usou continua valendo enquanto a tela o exibe.
 */
export const PORTAL_HIDDEN_TEMPLATE_KEYS = [
  PORTAL_TEMPLATE_KEYS.accessCode,
  PORTAL_TEMPLATE_KEYS.contactCode,
] as const

/**
 * Uma mensagem, como o tutor a relê (AC-01).
 *
 * **Só `sentAt`, e nenhuma outra data.** O modelo guarda entrega e leitura, e as duas
 * ficam aqui: dizer a alguém a que horas ele leu a própria mensagem é devolver-lhe uma
 * vigilância que ele não pediu, e não muda nada do que ele faz a seguir. O que a tela
 * precisa é quando o petshop falou.
 *
 * `category` desce porque a mesma tela tem o interruptor de promoções logo abaixo: sem
 * ela, quem desligou "novidades" não consegue reconhecer, na lista, qual mensagem vai
 * parar de chegar e qual continua.
 *
 * O corpo pode vir como aviso de expurgo — a retenção de 24 meses apaga o texto e
 * mantém a linha (AC-04 de MOD-CRM-10), e um histórico que estourasse ali seria um
 * histórico que só funciona no ano corrente.
 */
export const PortalMessageSchema = z.object({
  id: z.uuid(),
  channel: PortalChannelSchema,
  category: z.enum(['TRANSACTIONAL', 'OPERATIONAL', 'MARKETING']),
  subject: z.string().nullable(),
  body: z.string(),
  sentAt: z.string(),
})
export type PortalMessage = z.infer<typeof PortalMessageSchema>

/**
 * Paginação por página, como o extrato e pelo mesmo motivo.
 *
 * Uma campanha enfileira centenas de mensagens no mesmo instante, e `sent_at` repete
 * dentro do lote: um cursor por data pularia linhas ou as repetiria. O `total`
 * acompanha para a tela saber quando parar de oferecer "ver mais".
 */
export const PortalMessagesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
export type PortalMessagesQuery = z.output<typeof PortalMessagesQuerySchema>

export const PortalMessagesResponseSchema = z.object({
  messages: z.array(PortalMessageSchema),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  timezone: z.string(),
})
export type PortalMessagesResponse = z.infer<typeof PortalMessagesResponseSchema>

/**
 * O consentimento de um canal, como o interruptor o mostra (AC-03).
 *
 * **Ausência de registro é "desligado"** (LGPD art. 8º: silêncio não é consentimento),
 * e é por isso que a resposta traz sempre os dois canais em vez de só os decididos —
 * uma lista com o que existe faria a tela inventar o estado do que falta.
 *
 * `since` é a data da última transição, e vale como prova para quem lê: "você desligou
 * em 3 de setembro" responde sozinho a metade das reclamações de "continuo recebendo".
 */
export const PortalChannelPreferenceSchema = z.object({
  channel: PortalChannelSchema,
  granted: z.boolean(),
  since: z.string().nullable(),
})
export type PortalChannelPreference = z.infer<typeof PortalChannelPreferenceSchema>

/**
 * O que o tutor controla, e o que ele não controla.
 *
 * `marketing` é a lista de interruptores. `operational` **não é lista nenhuma**: é a
 * frase que explica por que confirmação de agendamento e aviso do motorista continuam
 * chegando. Essas rodam por execução de contrato (RN-01 do MOD-CRM) e desligá-las seria
 * o petshop deixar de avisar que a van está a caminho — dano ao próprio tutor.
 * Oferecer um interruptor desses e recusar o clique seria pior que não oferecer.
 */
export const PortalPreferencesResponseSchema = z.object({
  marketing: z.array(PortalChannelPreferenceSchema),
  /** Os canais que o tutor tem cadastrados. Sem e-mail, o interruptor de e-mail some. */
  availableChannels: z.array(PortalChannelSchema),
})
export type PortalPreferencesResponse = z.infer<typeof PortalPreferencesResponseSchema>

/**
 * Um clique é uma transição, e uma transição é uma linha nova (AC-04).
 *
 * Um canal por requisição, e não o par inteiro: mandar os dois faria o interruptor de
 * e-mail gravar uma linha de WhatsApp toda vez que alguém tocasse em qualquer um, e a
 * trilha jurídica passaria a registrar decisões que ninguém tomou.
 *
 * `purpose` não é campo: o Portal só decide `MARKETING`. Aceitá-lo do cliente
 * permitiria a um pedido forjado revogar o consentimento transacional e cortar os
 * avisos do próprio tutor.
 */
export const UpdatePortalPreferenceSchema = z
  .object({
    channel: PortalChannelSchema,
    granted: z.boolean(),
  })
  .strict()
export type UpdatePortalPreferenceInput = z.output<typeof UpdatePortalPreferenceSchema>

// ─── MOD-PORTAL-09 — Meus Dados ──────────────────────────────────────────────

/**
 * Prazo legal de resposta a um pedido do titular (LGPD art. 19, II).
 *
 * Quinze dias, e o número mora aqui porque duas telas o mostram: o Portal promete a
 * data ao tutor, e a fila da equipe usa a mesma para dizer o que está atrasado. Se cada
 * uma calculasse a sua, a equipe descobriria o vencimento depois do titular.
 */
export const PORTAL_DELETION_RESPONSE_DAYS = 15

/** Validade do código que confirma um contato novo (AC-02). */
export const PORTAL_CONTACT_CHANGE_TTL_MIN = 10

/**
 * O que a ficha do tutor mostra a ele mesmo.
 *
 * **O que não está aqui também é decisão.** `notes` fica de fora: é a anotação que a
 * recepção faz *sobre* o cliente ("chega sempre atrasado", "prefere a Ana"), e devolvê-la
 * ao titular transformaria um caderno de trabalho em correspondência. O saldo e as tags
 * moram no Financeiro; `dataCompleteness` e as datas de vínculo são telemetria nossa.
 *
 * CPF e CNPJ descem **mascarados**, como no balcão: o tutor os reconhece sem que a
 * resposta carregue o documento inteiro para dentro do navegador dele.
 */
export const PortalProfileSchema = z.object({
  fullName: z.string(),
  socialName: z.string().nullable(),
  /** O que o Portal chama de "como prefere ser chamado" — RN-14 do MOD-TUTOR. */
  displayName: z.string(),
  cpfMasked: z.string().nullable(),
  cnpjMasked: z.string().nullable(),
  phoneMasked: z.string(),
  email: z.string().nullable(),
  birthDate: z.string().nullable(),
})
export type PortalProfile = z.infer<typeof PortalProfileSchema>

/**
 * Um endereço do tutor, como ele o vê.
 *
 * **Sem latitude e longitude**, ao contrário do `AddressResponse` do Admin. A
 * geocodificação existe para roteirizar a van (MOD-TAXI) e não é dado que o titular
 * tenha pedido nem que o ajude a conferir a rua: descê-la só ampliaria a superfície.
 */
export const PortalAddressSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  zipCode: z.string(),
  street: z.string(),
  number: z.string(),
  complement: z.string().nullable(),
  district: z.string(),
  city: z.string(),
  state: z.string(),
  accessNotes: z.string().nullable(),
  isPrimary: z.boolean(),
})
export type PortalAddress = z.infer<typeof PortalAddressSchema>

/**
 * Um pedido de exclusão, como o tutor o acompanha (AC-05).
 *
 * A tela precisa dos três: que existe, quando vence o prazo e o que a equipe respondeu.
 * Sem o retorno, o tutor que teve o pedido recusado ficaria olhando para "em análise"
 * para sempre, e voltaria a pedir.
 */
export const PortalDeletionRequestSchema = z.object({
  id: z.uuid(),
  status: z.enum(['OPEN', 'DONE', 'REJECTED']),
  requestedAt: z.string(),
  /** O prazo do art. 19. Continua exibido depois de respondido, como registro. */
  dueAt: z.string(),
  respondedAt: z.string().nullable(),
  /** O que a equipe escreveu ao recusar ou ao concluir. */
  resolution: z.string().nullable(),
})
export type PortalDeletionRequest = z.infer<typeof PortalDeletionRequestSchema>

export const PortalMeDataResponseSchema = z.object({
  profile: PortalProfileSchema,
  addresses: z.array(PortalAddressSchema),
  /**
   * A troca de contato que está esperando código, quando há uma.
   *
   * Recarregar a página no meio da verificação é o caso comum — o tutor sai do
   * navegador para ler a mensagem e volta. Sem este campo ele voltaria para um
   * formulário vazio, e o desafio aberto viraria um fantasma que só expira.
   */
  pendingContact: z
    .object({
      id: z.uuid(),
      field: z.enum(['PHONE', 'EMAIL']),
      maskedTarget: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
  /** O pedido de exclusão em análise, ou o último respondido. */
  deletionRequest: PortalDeletionRequestSchema.nullable(),
})
export type PortalMeDataResponse = z.infer<typeof PortalMeDataResponseSchema>

/**
 * O que o tutor edita sozinho na própria ficha (AC-01 e AC-03).
 *
 * A lista é curta, e o motivo é o mesmo do MOD-PORTAL-03: **o que identifica ou precifica
 * não se corrige sem alguém do outro lado.** CPF e CNPJ são chave de deduplicação e de
 * identificação fiscal (AC-03). `fullName` acompanha os dois — é a outra metade da
 * identidade conferida no balcão, e uma ficha em nome de outra pessoa é o mesmo dano do
 * CPF trocado, sem o dígito verificador para denunciá-lo. Telefone e e-mail têm caminho
 * próprio, com reverificação, e por isso também não cabem aqui.
 *
 * Sobram o nome social — que é como a pessoa quer ser chamada, e ninguém decide isso por
 * ela — e a data de nascimento. `.strict()` é o que devolve 422 a quem mandar o resto: a
 * trava é o contrato, e não uma checagem que a próxima rota de escrita possa esquecer.
 */
export const UpdateOwnTutorSchema = z
  .object({
    socialName: z.string().max(120).nullable(),
    birthDate: z.iso.date().nullable(),
  })
  .strict()
  .partial()
export type UpdateOwnTutorInput = z.output<typeof UpdateOwnTutorSchema>

/**
 * Endereço, pelo Portal.
 *
 * Os mesmos campos e as mesmas regras do balcão, menos latitude e longitude: quem
 * geocodifica é o MOD-TAXI, e aceitar coordenadas do cliente deixaria o tutor mover o
 * ponto de coleta da van para qualquer lugar do mapa sem mudar uma letra do endereço.
 */
export const PortalAddressInputSchema = z
  .object({
    label: z.string().max(40).default('Casa'),
    zipCode: CEPSchema,
    street: z.string().min(3).max(160),
    number: z.string().max(20),
    complement: z.string().max(80).optional(),
    district: z.string().max(80),
    city: z.string().max(80),
    state: UFSchema,
    accessNotes: z.string().max(300).optional(),
    isPrimary: z.boolean().default(false),
  })
  .strict()
export type PortalAddressInput = z.output<typeof PortalAddressInputSchema>

export const UpdatePortalAddressSchema = PortalAddressInputSchema.partial()
export type UpdatePortalAddressInput = z.output<typeof UpdatePortalAddressSchema>

/** O campo de contato que a reverificação protege (AC-02). */
export const PortalContactFieldSchema = z.enum(['PHONE', 'EMAIL'])
export type PortalContactField = z.infer<typeof PortalContactFieldSchema>

/**
 * O canal decorre do campo, e não de um seletor.
 *
 * Confirmar um telefone novo por e-mail provaria a posse do e-mail antigo, que é
 * exatamente o que a reverificação **não** quer saber. O código tem de chegar ao
 * endereço que está sendo cadastrado, ou não prova nada.
 */
export function portalChannelOfField(field: PortalContactField): PortalChannel {
  return field === 'EMAIL' ? 'EMAIL' : 'WHATSAPP'
}

export const PortalContactChangeSchema = z
  .object({
    field: PortalContactFieldSchema,
    /** Validado por campo no serviço: telefone vira E.164, e-mail é normalizado. */
    value: z.string().trim().min(5).max(160),
  })
  .strict()
export type PortalContactChangeInput = z.output<typeof PortalContactChangeSchema>

/**
 * A resposta do pedido de troca.
 *
 * **`maskedTarget` sai do que o tutor digitou**, como no desafio de acesso, e aqui é até
 * mais direto: o valor ainda não está gravado em lugar nenhum. Mascarar mesmo assim é o
 * que impede um ombro na fila do mercado de ler o número inteiro na tela.
 */
export const PortalContactChangeResponseSchema = z.object({
  changeId: z.uuid(),
  field: PortalContactFieldSchema,
  channel: PortalChannelSchema,
  maskedTarget: z.string(),
  expiresInMin: z.number().int(),
})
export type PortalContactChangeResponse = z.infer<typeof PortalContactChangeResponseSchema>

export const PortalContactVerifySchema = z
  .object({
    changeId: z.uuid(),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict()
export type PortalContactVerifyInput = z.output<typeof PortalContactVerifySchema>

/**
 * O pedido de exclusão (AC-05).
 *
 * `reason` é opcional porque o titular **não deve satisfação**: a LGPD não condiciona o
 * pedido a justificativa, e exigir uma seria um obstáculo travestido de formulário. O
 * campo existe porque quem escreve costuma dizer o que resolveria o caso sem apagar
 * nada ("parem de me mandar promoção"), e a equipe responde melhor sabendo disso.
 */
export const PortalDeletionRequestInputSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict()
export type PortalDeletionRequestInput = z.output<typeof PortalDeletionRequestInputSchema>
