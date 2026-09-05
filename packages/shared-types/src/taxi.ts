import { z } from 'zod'

/**
 * MOD-TAXI — leva-e-traz (PRD taxi_dog_07 §4 e §5).
 *
 * Duas decisões deste módulo estão codificadas aqui e valem ser lidas antes do
 * resto:
 *
 * **1. Ida e volta são duas linhas.** O SPEC §129 previa uma só, com
 * `tipo [ida/volta/ambos]`. Cada perna tem janela, motorista, veículo, status, hora
 * real e falha próprios — em uma linha só, cada um desses campos precisaria de um
 * gêmeo com sufixo `_volta`, e a máquina de estado teria de rodar duas vezes dentro
 * do mesmo registro (RN-02).
 *
 * **2. Não existe corrida sem agendamento.** O Taxi Dog é complemento da agenda
 * (§7.6 do PRD-mãe), não uma segunda agenda. Corrida solta viraria um segundo lugar
 * para conciliar — que é exatamente o que este módulo existe para acabar (RN-01).
 */

// ─── Enums de domínio ────────────────────────────────────────────────────────

export const TAXI_LEGS = ['PICKUP', 'DROPOFF'] as const
export const TaxiLegSchema = z.enum(TAXI_LEGS)
export type TaxiLeg = z.infer<typeof TaxiLegSchema>

export const TAXI_LEG_LABELS: Record<TaxiLeg, string> = {
  PICKUP: 'Buscar',
  DROPOFF: 'Levar',
}

export const TAXI_RIDE_STATUSES = [
  'REQUESTED',
  'ASSIGNED',
  'EN_ROUTE',
  'ARRIVED',
  'ONBOARD',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const
export const TaxiRideStatusSchema = z.enum(TAXI_RIDE_STATUSES)
export type TaxiRideStatus = z.infer<typeof TaxiRideStatusSchema>

export const TAXI_RIDE_STATUS_LABELS: Record<TaxiRideStatus, string> = {
  REQUESTED: 'Sem motorista',
  ASSIGNED: 'Atribuída',
  EN_ROUTE: 'A caminho',
  ARRIVED: 'No local',
  ONBOARD: 'Pet a bordo',
  DELIVERED: 'Entregue',
  FAILED: 'Não realizada',
  CANCELLED: 'Cancelada',
}

/** Terminais: de onde não se sai. */
export const TAXI_TERMINAL_STATUSES = ['DELIVERED', 'FAILED', 'CANCELLED'] as const

/**
 * Status que ocupam lugar na van (RN-09).
 *
 * `REQUESTED` fica de fora de propósito: corrida sem motorista não ocupa a van de
 * ninguém, porque ainda não tem van. É a contrapartida do `OCCUPYING_STATUSES` da
 * agenda, com a mesma lógica — o que conta é o que está comprometido, não o que foi
 * pedido.
 */
export const TAXI_OCCUPYING_STATUSES = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD'] as const

export const TAXI_PRICE_SOURCES = ['ZONE', 'DEFAULT', 'MANUAL'] as const
export const TaxiPriceSourceSchema = z.enum(TAXI_PRICE_SOURCES)
export type TaxiPriceSource = z.infer<typeof TaxiPriceSourceSchema>

export const TAXI_FAILURE_REASONS = [
  'NO_ONE_HOME',
  'WRONG_ADDRESS',
  'PET_REFUSED',
  'NO_SPACE',
  'VEHICLE_ISSUE',
  'OTHER',
] as const
export const TaxiFailureReasonSchema = z.enum(TAXI_FAILURE_REASONS)
export type TaxiFailureReason = z.infer<typeof TaxiFailureReasonSchema>

export const TAXI_FAILURE_REASON_LABELS: Record<TaxiFailureReason, string> = {
  NO_ONE_HOME: 'Ninguém atendeu',
  WRONG_ADDRESS: 'Endereço errado',
  PET_REFUSED: 'O pet não embarcou',
  NO_SPACE: 'Sem espaço na van',
  VEHICLE_ISSUE: 'Problema no veículo',
  OTHER: 'Outro motivo',
}

/**
 * O mesmo motivo, dito ao **tutor** (AC-03 de MOD-CRM-09).
 *
 * Duas listas porque são dois públicos. "Ninguém atendeu" é o que a recepção lê no
 * painel: seco, cabe numa coluna, e ela sabe o contexto. O tutor recebe uma mensagem no
 * celular sem contexto nenhum, e a frase precisa carregá-lo junto — nunca o enum, e
 * nunca uma etiqueta de sistema traduzida ao pé da letra.
 *
 * São frases de meio de período: o template as encaixa depois de "não conseguimos
 * buscar o Thor hoje".
 */
export const TAXI_FAILURE_REASON_TUTOR_TEXT: Record<TaxiFailureReason, string> = {
  NO_ONE_HOME: 'não conseguimos encontrar ninguém no endereço',
  WRONG_ADDRESS: 'não conseguimos localizar o endereço',
  PET_REFUSED: 'o pet não quis embarcar',
  NO_SPACE: 'não havia espaço no veículo desta vez',
  VEHICLE_ISSUE: 'tivemos um problema com o veículo',
  OTHER: 'houve um imprevisto no caminho',
}

/**
 * O status da corrida dito ao **tutor** (AC-05 de MOD-PORTAL-07).
 *
 * Terceira lista de rótulos do módulo, pela mesma razão da segunda: são públicos
 * diferentes. `TAXI_RIDE_STATUS_LABELS` é a coluna do painel, escrita para quem opera —
 * "Sem motorista" e "Atribuída" descrevem a fila interna. O tutor lendo "Sem motorista"
 * no celular entende que ninguém vai buscar o pet dele, e liga para o petshop; é
 * exatamente o telefonema que o Portal existe para evitar.
 *
 * `REQUESTED` e `ASSIGNED` colapsam em "Programado" de propósito: se um motorista já foi
 * escalado é decisão de escala, e a escala muda três vezes antes da hora. O que o tutor
 * precisa saber é que a corrida está de pé.
 *
 * A perna entra no texto porque "Entregue" numa coleta e numa devolução são lugares
 * opostos — o pet no petshop e o pet em casa.
 */
export function taxiStatusTutorText(leg: TaxiLeg, status: TaxiRideStatus): string {
  switch (status) {
    case 'REQUESTED':
    case 'ASSIGNED':
      return 'Programado'
    case 'EN_ROUTE':
      return leg === 'PICKUP' ? 'A caminho do seu endereço' : 'A caminho da sua casa'
    case 'ARRIVED':
      return 'Chegou'
    case 'ONBOARD':
      return 'Com o pet a bordo'
    case 'DELIVERED':
      return leg === 'PICKUP' ? 'Pet no petshop' : 'Pet em casa'
    case 'FAILED':
      return 'Não realizada'
    case 'CANCELLED':
      return 'Cancelada'
  }
}

export const TAXI_CANCEL_REASONS = [
  'TUTOR_REQUEST',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
  'PET_DECEASED',
  'SHOP_REQUEST',
] as const
export const TaxiCancelReasonSchema = z.enum(TAXI_CANCEL_REASONS)
export type TaxiCancelReason = z.infer<typeof TaxiCancelReasonSchema>

export const TAXI_CANCEL_REASON_LABELS: Record<TaxiCancelReason, string> = {
  TUTOR_REQUEST: 'A pedido do tutor',
  APPOINTMENT_CANCELLED: 'O agendamento foi cancelado',
  APPOINTMENT_RESCHEDULED: 'O agendamento foi remarcado',
  PET_DECEASED: 'Óbito do pet',
  SHOP_REQUEST: 'Decisão do petshop',
}

/**
 * Motivos que o tutor **não** deve ser avisado (AC-03 de MOD-TAXI-08).
 *
 * O óbito é o caso que justifica a lista existir: um "sua corrida foi cancelada"
 * automático nessa hora é crueldade operacional. A cascata de agendamento também
 * cala, porque o tutor já foi avisado do cancelamento do atendimento — dois avisos
 * para o mesmo fato ensinam a ignorar o canal.
 */
export const TAXI_SILENT_CANCEL_REASONS: readonly TaxiCancelReason[] = [
  'PET_DECEASED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
]

// ─── Máquina de estado (§6) ──────────────────────────────────────────────────

/**
 * Transições permitidas.
 *
 * Duas regras não óbvias moram nesta tabela:
 *
 * **`ONBOARD` não cancela.** De `ONBOARD` só se sai por `DELIVERED` ou `FAILED`
 * (AC-06 de MOD-TAXI-09): o pet está fisicamente dentro da van, e o sistema tem de
 * dizer onde ele foi parar. "Cancelado" com pet a bordo é um registro que mente
 * sobre a localização de um animal.
 *
 * **`FAILED` só a partir de quem já saiu.** Falhar antes de `EN_ROUTE` é cancelar —
 * e são coisas diferentes na conta do tutor (RN-16) e na métrica de falha por causa.
 */
export const TAXI_TRANSITIONS: Record<TaxiRideStatus, readonly TaxiRideStatus[]> = {
  REQUESTED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['EN_ROUTE', 'REQUESTED', 'CANCELLED'],
  EN_ROUTE: ['ARRIVED', 'FAILED', 'CANCELLED'],
  ARRIVED: ['ONBOARD', 'FAILED', 'CANCELLED'],
  ONBOARD: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
}

export function canTransition(from: TaxiRideStatus, to: TaxiRideStatus): boolean {
  return TAXI_TRANSITIONS[from].includes(to)
}

/** O marco de tempo que cada status carimba na corrida. */
export const TAXI_STATUS_TIMESTAMP: Partial<Record<TaxiRideStatus, string>> = {
  ASSIGNED: 'assignedAt',
  EN_ROUTE: 'enRouteAt',
  ARRIVED: 'arrivedAt',
  ONBOARD: 'onboardAt',
  DELIVERED: 'deliveredAt',
}

// ─── Regras de tempo ─────────────────────────────────────────────────────────

/**
 * Retroação máxima de `occurredAt` (AC-05 de MOD-TAXI-04).
 *
 * Seis horas cobrem o turno inteiro de um motorista sem sinal e ainda recusam a
 * digitação de uma corrida de ontem como se fosse de agora. `recordedAt` é sempre o
 * servidor, e as duas ficam no log — quem audita precisa ver que houve retroação.
 */
export const TAXI_BACKDATE_LIMIT_MS = 6 * 60 * 60 * 1000

// ─── Endereço ────────────────────────────────────────────────────────────────

/**
 * Endereço informado na corrida. Omitido, herda o primário do tutor e é **copiado**
 * para a corrida (RN-11): mudar o cadastro depois não reescreve para onde o motorista
 * foi.
 */
export const TaxiAddressInputSchema = z.object({
  zipCode: z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos'),
  street: z.string().trim().min(1).max(120),
  number: z.string().trim().min(1).max(20),
  complement: z.string().trim().max(60).optional(),
  district: z.string().trim().min(1).max(80),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().length(2).toUpperCase(),
  accessNotes: z.string().trim().max(500).optional(),
})
export type TaxiAddressInput = z.infer<typeof TaxiAddressInputSchema>

// ─── MOD-TAXI-01 — solicitação ───────────────────────────────────────────────

export const TaxiLegInputSchema = z.object({
  leg: TaxiLegSchema,
  windowStartsAt: z.coerce.date(),
  windowEndsAt: z.coerce.date(),
  /** Omitido, herda o endereço primário do tutor (AC-01/02 de MOD-TAXI-02). */
  address: TaxiAddressInputSchema.optional(),
  /** Omitido, a corrida nasce em `REQUESTED`, na fila sem dono (AC-05 de MOD-TAXI-03). */
  driverId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
  /** AC-04 de MOD-TAXI-06: exige `taxi:configure` e justificativa. */
  priceCentsOverride: z.number().int().min(0).max(100_000_00).optional(),
  priceOverrideReason: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
})
export type TaxiLegInput = z.infer<typeof TaxiLegInputSchema>

export const CreateTaxiRidesSchema = z
  .object({
    /** RN-01: obrigatório. Não existe corrida sem agendamento. */
    appointmentId: z.uuid(),
    legs: z.array(TaxiLegInputSchema).min(1).max(2),
  })
  .refine((value) => new Set(value.legs.map((leg) => leg.leg)).size === value.legs.length, {
    message: 'Não repita a mesma perna na mesma chamada',
    path: ['legs'],
  })
  .refine((value) => value.legs.every((leg) => leg.windowEndsAt > leg.windowStartsAt), {
    message: 'A janela precisa terminar depois de começar',
    path: ['legs'],
  })
  .refine(
    (value) => value.legs.every((leg) => !leg.priceCentsOverride || leg.priceOverrideReason),
    { message: 'Preço manual exige justificativa', path: ['legs'] },
  )
export type CreateTaxiRidesInput = z.infer<typeof CreateTaxiRidesSchema>

export const UpdateTaxiRideSchema = z
  .object({
    windowStartsAt: z.coerce.date().optional(),
    windowEndsAt: z.coerce.date().optional(),
    address: TaxiAddressInputSchema.optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nada a atualizar' })
  .refine(
    (value) =>
      value.windowStartsAt === undefined ||
      value.windowEndsAt === undefined ||
      value.windowEndsAt > value.windowStartsAt,
    { message: 'A janela precisa terminar depois de começar', path: ['windowEndsAt'] },
  )
export type UpdateTaxiRideInput = z.infer<typeof UpdateTaxiRideSchema>

// ─── MOD-TAXI-03 — atribuição ────────────────────────────────────────────────

export const AssignTaxiRideSchema = z.object({
  driverId: z.uuid(),
  /** Opcional (§11 Q8): sem veículo, vale só a capacidade do motorista. */
  vehicleId: z.uuid().nullable().optional(),
})
export type AssignTaxiRideInput = z.infer<typeof AssignTaxiRideSchema>

// ─── MOD-TAXI-04 — execução ──────────────────────────────────────────────────

export const TaxiStatusTransitionSchema = z.object({
  to: TaxiRideStatusSchema,
  /** AC-05: retroação de até 6h; nunca futuro. A validação do limite é do serviço. */
  occurredAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
})
export type TaxiStatusTransitionInput = z.infer<typeof TaxiStatusTransitionSchema>

export const FailTaxiRideSchema = z.object({
  reason: TaxiFailureReasonSchema,
  notes: z.string().trim().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
})
export type FailTaxiRideInput = z.infer<typeof FailTaxiRideSchema>

export const CancelTaxiRideSchema = z.object({
  reason: TaxiCancelReasonSchema.default('TUTOR_REQUEST'),
  notes: z.string().trim().max(500).optional(),
})
export type CancelTaxiRideInput = z.infer<typeof CancelTaxiRideSchema>

// ─── MOD-TAXI-06 — zonas ─────────────────────────────────────────────────────

/**
 * Prefixo de CEP, 2 a 8 dígitos. O **mais longo vence** (RN-17): `010012` ganha de
 * `0100`, porque quem cadastrou o prefixo mais específico estava descrevendo a
 * exceção.
 */
const ZipPrefixSchema = z.string().regex(/^\d{2,8}$/, 'Prefixo deve ter de 2 a 8 dígitos')

export const TaxiZoneSchema = z.object({
  name: z.string().trim().min(1).max(60),
  zipPrefixes: z.array(ZipPrefixSchema).min(1).max(50),
  priceCents: z.number().int().min(0).max(100_000_00),
  active: z.boolean().default(true),
})
export type TaxiZoneInput = z.infer<typeof TaxiZoneSchema>

export const UpdateTaxiZoneSchema = TaxiZoneSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nada a atualizar' },
)
export type UpdateTaxiZoneInput = z.infer<typeof UpdateTaxiZoneSchema>

/**
 * Resolve a zona de um CEP pelo prefixo mais longo (RN-17).
 *
 * Vive em `shared-types` e não no serviço porque a tela de zonas precisa da mesma
 * resposta para mostrar "este CEP cairia na Zona Sul" **antes** de salvar — e duas
 * implementações da mesma regra divergiriam no primeiro caso de borda.
 */
export function resolveZipZone<T extends { zipPrefixes: string[] }>(
  zipCode: string,
  zones: readonly T[],
): T | null {
  let best: T | null = null
  let bestLength = -1
  for (const zone of zones) {
    for (const prefix of zone.zipPrefixes) {
      if (zipCode.startsWith(prefix) && prefix.length > bestLength) {
        best = zone
        bestLength = prefix.length
      }
    }
  }
  return best
}

// ─── MOD-TAXI-03 — frota ─────────────────────────────────────────────────────

/** Placa antiga (`ABC1234`) ou Mercosul (`ABC1D23`), sem hífen e em maiúsculas. */
const PlateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/, 'Placa inválida')

export const TaxiVehicleSchema = z.object({
  plate: PlateSchema,
  label: z.string().trim().min(1).max(40),
  model: z.string().trim().max(40).optional(),
  petCapacity: z.number().int().min(1).max(20),
  active: z.boolean().default(true),
})
export type TaxiVehicleInput = z.infer<typeof TaxiVehicleSchema>

export const UpdateTaxiVehicleSchema = TaxiVehicleSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nada a atualizar' },
)
export type UpdateTaxiVehicleInput = z.infer<typeof UpdateTaxiVehicleSchema>

// ─── Configuração do módulo ──────────────────────────────────────────────────

export const TaxiSettingsSchema = z.object({
  /** RN-22: o petshop sem van não vê campo morto no wizard de agendamento. */
  enabled: z.boolean(),
  /** O serviço de categoria `TAXI` que ancora a cobrança (RN-05). */
  taxiServiceId: z.uuid().nullable(),
  defaultPriceCents: z.number().int().min(0).max(100_000_00),
  /** RN-18: bloquear CEP fora de zona é opt-in. */
  blockOutsideZones: z.boolean(),
  /** RN-16: porta fechada não se cobra por padrão. */
  chargeFailedPickup: z.boolean(),
  defaultWindowMinutes: z.number().int().min(15).max(240),
  unassignedAlertHours: z.number().int().min(1).max(72),
})
export type TaxiSettings = z.infer<typeof TaxiSettingsSchema>

export const UpdateTaxiSettingsSchema = TaxiSettingsSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nada a atualizar' },
)
export type UpdateTaxiSettingsInput = z.infer<typeof UpdateTaxiSettingsSchema>

export const TAXI_SETTINGS_DEFAULTS: Omit<TaxiSettings, 'taxiServiceId'> = {
  enabled: false,
  defaultPriceCents: 0,
  blockOutsideZones: false,
  chargeFailedPickup: false,
  defaultWindowMinutes: 60,
  unassignedAlertHours: 12,
}

// ─── Consultas ───────────────────────────────────────────────────────────────

export const ListTaxiRidesQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: TaxiRideStatusSchema.optional(),
  leg: TaxiLegSchema.optional(),
  driverId: z.uuid().optional(),
  tutorId: z.uuid().optional(),
  appointmentId: z.uuid().optional(),
  /** `true` traz só a fila sem dono — a faixa do topo do painel. */
  unassigned: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListTaxiRidesQuery = z.infer<typeof ListTaxiRidesQuerySchema>

export const TaxiDayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})
export type TaxiDayQuery = z.infer<typeof TaxiDayQuerySchema>

/**
 * Preço de uma perna sem criar nada.
 *
 * Existe separado porque o Portal e o agente de IA precisam responder "quanto custa
 * buscar aqui?" **antes** de existir agendamento — e um POST que cria corrida para
 * descobrir o preço deixaria lixo no painel a cada pergunta.
 */
export const TaxiQuoteQuerySchema = z.object({
  zipCode: z.string().regex(/^\d{8}$/),
})
export type TaxiQuoteQuery = z.infer<typeof TaxiQuoteQuerySchema>

export const AvailableDriversQuerySchema = z
  .object({
    windowStartsAt: z.coerce.date(),
    windowEndsAt: z.coerce.date(),
  })
  .refine((value) => value.windowEndsAt > value.windowStartsAt, {
    message: 'A janela precisa terminar depois de começar',
    path: ['windowEndsAt'],
  })
export type AvailableDriversQuery = z.infer<typeof AvailableDriversQuerySchema>

// ─── Respostas da API ────────────────────────────────────────────────────────
//
// Vivem aqui, junto dos schemas de entrada, porque o `@petshop/api-client` valida a
// resposta com eles: é o contrato do §5 sendo conferido em tempo de execução, e não
// só declarado num tipo que some no build.

export const TaxiRideAddressSchema = z.object({
  zipCode: z.string(),
  street: z.string(),
  number: z.string(),
  complement: z.string().nullable(),
  district: z.string(),
  city: z.string(),
  state: z.string(),
  accessNotes: z.string().nullable(),
})

export const TaxiRideResponseSchema = z.object({
  id: z.string(),
  appointmentId: z.string(),
  petId: z.string(),
  tutorId: z.string(),
  leg: TaxiLegSchema,
  legLabel: z.string(),
  status: TaxiRideStatusSchema,
  statusLabel: z.string(),
  windowStartsAt: z.string(),
  windowEndsAt: z.string(),
  driverId: z.string().nullable(),
  vehicleId: z.string().nullable(),
  address: TaxiRideAddressSchema,
  zoneId: z.string().nullable(),
  priceCents: z.number(),
  priceSource: TaxiPriceSourceSchema,
  readyAt: z.string().nullable(),
  timestamps: z.object({
    assignedAt: z.string().nullable(),
    enRouteAt: z.string().nullable(),
    arrivedAt: z.string().nullable(),
    onboardAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
  }),
  failureReason: TaxiFailureReasonSchema.nullable(),
  cancelReason: TaxiCancelReasonSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
})
export type TaxiRideResponse = z.infer<typeof TaxiRideResponseSchema>

export const TaxiRidesCreatedSchema = z.object({ items: z.array(TaxiRideResponseSchema) })

export const PaginatedTaxiRidesSchema = z.object({
  items: z.array(TaxiRideResponseSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
})
export type PaginatedTaxiRides = z.infer<typeof PaginatedTaxiRidesSchema>

export const TaxiBoardSchema = z.object({
  date: z.string(),
  timezone: z.string(),
  unassigned: z.array(TaxiRideResponseSchema),
  lanes: z.array(
    z.object({
      driverId: z.string(),
      displayName: z.string(),
      rides: z.array(TaxiRideResponseSchema),
      overdue: z.number(),
    }),
  ),
  closed: z.array(TaxiRideResponseSchema),
  totals: z.object({
    rides: z.number(),
    unassigned: z.number(),
    overdue: z.number(),
    delivered: z.number(),
  }),
})
export type TaxiBoard = z.infer<typeof TaxiBoardSchema>

export const HandlingAlertSchema = z.object({
  kind: z.enum(['MEDICAL', 'TEMPERAMENT']),
  severity: z.string(),
  label: z.string(),
})

export const TaxiRouteSchema = z.object({
  date: z.string(),
  timezone: z.string(),
  stops: z.array(
    TaxiRideResponseSchema.extend({
      petName: z.string(),
      tutorName: z.string(),
      tutorPhone: z.string().nullable(),
      alerts: z.array(HandlingAlertSchema),
      requiresMuzzle: z.boolean(),
      requiresTwoHandlers: z.boolean(),
      waitingForAttendance: z.boolean(),
    }),
  ),
})
export type TaxiRoute = z.infer<typeof TaxiRouteSchema>
export type TaxiRouteStop = TaxiRoute['stops'][number]

/** O que `fail` e `cancel` devolvem: a corrida e o efeito na cobrança. */
export const ClosedTaxiRideSchema = z.object({
  ride: TaxiRideResponseSchema,
  chargeRemoved: z.boolean(),
})
export type ClosedTaxiRide = z.infer<typeof ClosedTaxiRideSchema>

export const TaxiZoneResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  zipPrefixes: z.array(z.string()),
  priceCents: z.number(),
  active: z.boolean(),
})
export type TaxiZoneResponse = z.infer<typeof TaxiZoneResponseSchema>

export const TaxiVehicleResponseSchema = z.object({
  id: z.string(),
  plate: z.string(),
  label: z.string(),
  model: z.string().nullable(),
  petCapacity: z.number(),
  active: z.boolean(),
})
export type TaxiVehicleResponse = z.infer<typeof TaxiVehicleResponseSchema>

export const TaxiQuoteSchema = z.object({
  zipCode: z.string(),
  priceCents: z.number(),
  priceSource: TaxiPriceSourceSchema,
  zone: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
})
export type TaxiQuote = z.infer<typeof TaxiQuoteSchema>

export const AvailableTaxiDriverSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capacity: z.number(),
  occupied: z.number(),
  remaining: z.number(),
})
export type AvailableTaxiDriver = z.infer<typeof AvailableTaxiDriverSchema>
