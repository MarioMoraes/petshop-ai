import { z } from 'zod'

/**
 * MOD-AGENDA — catálogo de serviços, profissionais e bloqueios
 * (PRD agenda_operacao_06 §5, sub-features 01 a 03).
 *
 * O agendamento em si (04 em diante) entra na fatia seguinte; o que está aqui é o que
 * a agenda precisa **antes** de existir: o que se vende, quem executa e quando não dá.
 */

export const SERVICE_CATEGORIES = ['BATH', 'GROOMING', 'VET', 'VACCINE', 'OTHER'] as const
export const ServiceCategorySchema = z.enum(SERVICE_CATEGORIES)
export type ServiceCategory = z.infer<typeof ServiceCategorySchema>

export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  BATH: 'Banho',
  GROOMING: 'Tosa',
  VET: 'Veterinário',
  VACCINE: 'Vacina',
  OTHER: 'Outros',
}

/** Grade de 15 minutos (convenção do §4 do PRD); toda duração é múltipla dela. */
export const SCHEDULE_GRID_MIN = 15

/** Minutos desde a meia-noite, no fuso do tenant. 1440 = 24h. */
const MinuteOfDaySchema = z.number().int().min(0).max(1440)

// ─── MOD-AGENDA-01 — catálogo de serviços ────────────────────────────────────

/**
 * Preço **e** duração por porte.
 *
 * Os dois são obrigatórios porque a duração por porte é tabela, não multiplicador
 * sobre a base (decisão do §11 Q1, contra o RN-03 de pets_03): o petshop precisa
 * poder dizer que banho em Golden leva 90 min sem que isso mexa em nenhum outro
 * serviço. `services.base_duration_min` continua existindo, mas só como valor que a
 * UI sugere ao criar as linhas — nunca como fonte de cálculo.
 */
export const ServicePricingItemSchema = z.object({
  sizeId: z.uuid(),
  priceCents: z.number().int().min(0).max(100_000_00),
  durationMin: z
    .number()
    .int()
    .min(SCHEDULE_GRID_MIN)
    .max(600)
    .refine((value) => value % SCHEDULE_GRID_MIN === 0, {
      message: `A duração deve ser múltipla de ${SCHEDULE_GRID_MIN} minutos`,
    }),
})
export type ServicePricingItem = z.infer<typeof ServicePricingItemSchema>

export const CreateServiceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  category: ServiceCategorySchema,
  baseDurationMin: z
    .number()
    .int()
    .min(SCHEDULE_GRID_MIN)
    .max(600)
    .refine((value) => value % SCHEDULE_GRID_MIN === 0, {
      message: `A duração deve ser múltipla de ${SCHEDULE_GRID_MIN} minutos`,
    }),
  /** Restringe a execução ao papel VET (§3 AC-01). */
  requiresVet: z.boolean().default(false),
  description: z.string().trim().max(300).optional(),
  /** Cria as linhas de `service_pricing` junto; vazio deixa o serviço sem preço. */
  pricing: z.array(ServicePricingItemSchema).default([]),
  /** Habilita profissionais já no cadastro (AC-01 de MOD-AGENDA-01). */
  professionalIds: z.array(z.uuid()).default([]),
})
export type CreateServiceInput = z.output<typeof CreateServiceSchema>

export const UpdateServiceSchema = CreateServiceSchema.omit({
  pricing: true,
  professionalIds: true,
})
  .partial()
  .extend({
    /** AC-03: desativar some do seletor sem tocar nos agendamentos existentes. */
    active: z.boolean().optional(),
    professionalIds: z.array(z.uuid()).optional(),
  })
export type UpdateServiceInput = z.output<typeof UpdateServiceSchema>

/** `PUT` de propósito: a tabela de preços é substituída inteira, não remendada. */
export const ReplaceServicePricingSchema = z.object({
  pricing: z.array(ServicePricingItemSchema),
})

// ─── MOD-AGENDA-02 — profissionais e jornada ─────────────────────────────────

export const CreateProfessionalSchema = z.object({
  /** Membership de origem; nulo é o profissional sem login (§4). */
  userId: z.uuid().nullish(),
  displayName: z.string().trim().min(2).max(60),
  roleKey: z.enum(['GROOMER', 'BATHER', 'VET', 'DRIVER']),
  /**
   * Capacidade **simultânea**, não sequencial: o banhista lava um pet, põe para secar
   * e começa o próximo. Conflito é `count(sobreposições) >= limite`, não "existe
   * sobreposição" (decisão do §11 Q7).
   */
  maxConcurrentPets: z.number().int().min(1).max(20).default(1),
  /** Cor da coluna no painel do dia. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB')
    .nullish(),
  serviceIds: z.array(z.uuid()).default([]),
})
export type CreateProfessionalInput = z.output<typeof CreateProfessionalSchema>

export const UpdateProfessionalSchema = CreateProfessionalSchema.omit({
  userId: true,
  serviceIds: true,
})
  .partial()
  .extend({
    /** AC-04: desativar com agendamento futuro exige reatribuição antes. */
    active: z.boolean().optional(),
    serviceIds: z.array(z.uuid()).optional(),
  })
export type UpdateProfessionalInput = z.output<typeof UpdateProfessionalSchema>

/**
 * Uma faixa contínua de trabalho. O almoço não é um campo: é o que parte o dia em
 * duas faixas, e por isso `weekday` aceita várias linhas (§4).
 */
export const ScheduleWindowSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startsAtMin: MinuteOfDaySchema,
    endsAtMin: MinuteOfDaySchema,
  })
  .refine((window) => window.endsAtMin > window.startsAtMin, {
    message: 'O horário de término deve ser depois do início',
    path: ['endsAtMin'],
  })
export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>

export const ReplaceScheduleSchema = z.object({
  windows: z.array(ScheduleWindowSchema),
})

// ─── MOD-AGENDA-03 — bloqueios e folgas ──────────────────────────────────────

export const CreateCalendarBlockSchema = z
  .object({
    /**
     * Nulo é o feriado: bloqueia o tenant inteiro sem precisar de uma linha por
     * pessoa (AC-03 de MOD-AGENDA-03).
     */
    professionalId: z.uuid().nullish(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    reason: z.string().trim().max(120).optional(),
    /**
     * AC-02: o bloqueio sobre agendamento existente devolve 409 com os afetados. O
     * cliente reenvia dizendo o que fazer com eles — e cancelamento em lote por
     * bloqueio não gera taxa de no-show (RN-12), porque a falta é nossa.
     */
    onConflict: z.enum(['FAIL', 'CANCEL']).default('FAIL'),
  })
  .refine((block) => new Date(block.endsAt) > new Date(block.startsAt), {
    message: 'O término do bloqueio deve ser depois do início',
    path: ['endsAt'],
  })
export type CreateCalendarBlockInput = z.output<typeof CreateCalendarBlockSchema>

export const CalendarBlockQuerySchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  professionalId: z.uuid().optional(),
})

// ─── Respostas ───────────────────────────────────────────────────────────────
// Declaradas aqui, e não inferidas do Prisma, para que o cliente de API valide o
// que chega e o frontend compartilhe o mesmo tipo do backend.

export const ServicePricingResponseSchema = z.object({
  sizeId: z.uuid(),
  priceCents: z.number().int(),
  durationMin: z.number().int(),
})

export const ServiceResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  category: ServiceCategorySchema,
  description: z.string().nullable(),
  baseDurationMin: z.number().int(),
  requiresVet: z.boolean(),
  active: z.boolean(),
  pricing: z.array(ServicePricingResponseSchema),
  professionalIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ServiceResponse = z.infer<typeof ServiceResponseSchema>

export const ScheduleWindowResponseSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startsAtMin: z.number().int(),
  endsAtMin: z.number().int(),
})

export const ProfessionalResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid().nullable(),
  displayName: z.string(),
  roleKey: z.string(),
  maxConcurrentPets: z.number().int(),
  color: z.string().nullable(),
  active: z.boolean(),
  serviceIds: z.array(z.uuid()),
  schedule: z.array(ScheduleWindowResponseSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ProfessionalResponse = z.infer<typeof ProfessionalResponseSchema>

/** O `PUT` da jornada devolve o profissional **mais** os avisos do AC-03. */
export const ProfessionalWithWarningsSchema = ProfessionalResponseSchema.extend({
  warnings: z.array(z.string()),
})

export const CalendarBlockResponseSchema = z.object({
  id: z.uuid(),
  professionalId: z.uuid().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  reason: z.string().nullable(),
  scope: z.enum(['PROFESSIONAL', 'TENANT']),
  createdAt: z.iso.datetime(),
})
export type CalendarBlockResponse = z.infer<typeof CalendarBlockResponseSchema>

/** A criação do bloqueio informa o que foi cancelado em lote (AC-02). */
export const CalendarBlockCreatedSchema = CalendarBlockResponseSchema.extend({
  cancelledAppointmentIds: z.array(z.uuid()),
})

export const ResolvedPricingSchema = z.object({
  serviceId: z.uuid(),
  sizeId: z.uuid(),
  priceCents: z.number().int(),
  durationMin: z.number().int(),
})

// ─── MOD-AGENDA-04, 10 e 11 — agendamento ────────────────────────────────────

export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'RESCHEDULED',
] as const
export const AppointmentStatusSchema = z.enum(APPOINTMENT_STATUSES)
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>

/** Todos os valores da coluna — é o que a **leitura** devolve. */
export const AppointmentSourceSchema = z.enum([
  'STAFF',
  'PORTAL',
  'RECURRENCE',
  'AI_AGENT',
  'WALK_IN',
])
export type AppointmentSource = z.infer<typeof AppointmentSourceSchema>

/**
 * O subconjunto que se pode **pedir** ao criar um agendamento. `WALK_IN` fica de
 * fora: o encaixe nasce por `POST /v1/appointments/walk-in`, já concluído, e um
 * agendamento futuro marcado como encaixe seria uma contradição — encaixe é o que
 * não foi marcado.
 */
export const BookableSourceSchema = z.enum(['STAFF', 'PORTAL', 'RECURRENCE', 'AI_AGENT'])

export const CreateAppointmentSchema = z.object({
  petId: z.uuid(),
  professionalId: z.uuid(),
  startsAt: z.iso.datetime(),
  items: z.array(z.object({ serviceId: z.uuid() })).min(1).max(10),
  notes: z.string().trim().max(1000).optional(),
  /** MOD-AGENDA-10 AC-01: reconhecimento consciente do alerta clínico crítico. */
  acknowledgedAlerts: z.boolean().default(false),
  /** AC-02: libera o gate de inadimplência; exige permissão de override. */
  override: z.object({ reason: z.string().trim().min(10).max(300) }).optional(),
  source: BookableSourceSchema.default('STAFF'),
})
export type CreateAppointmentInput = z.output<typeof CreateAppointmentSchema>

export const CheckoutSchema = z.object({
  /** Convenção do MOD-LEDGER: todo POST que move dinheiro é idempotente. */
  idempotencyKey: z.uuid(),
  weightKg: z.number().min(0.05).max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** RN-18: serviço acrescentado durante a execução. */
  extraItems: z.array(z.object({ serviceId: z.uuid() })).max(10).default([]),
})

/**
 * O encaixe (AC-03 de MOD-PRONT-01): o pet chegou sem hora marcada.
 *
 * Não há `startsAt` — o intervalo é reconstruído da duração estimada, terminando
 * agora. Pedir o horário a quem está fechando a conta seria perguntar uma coisa que
 * o sistema sabe calcular, no pior momento possível.
 */
export const CreateWalkInSchema = z.object({
  petId: z.uuid(),
  professionalId: z.uuid(),
  items: z.array(z.object({ serviceId: z.uuid() })).min(1).max(10),
  /** Convenção do MOD-LEDGER: todo POST que move dinheiro é idempotente. */
  idempotencyKey: z.uuid(),
  weightKg: z.number().min(0.05).max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
})
export type CreateWalkInInput = z.output<typeof CreateWalkInSchema>

export const CancelAppointmentSchema = z.object({
  reason: z.string().trim().max(300).optional(),
  /** O Portal não envia; a recepção pode isentar a taxa do cancelamento tardio. */
  waiveFee: z.boolean().default(false),
})

export const AvailabilityQuerySchema = z.object({
  serviceId: z.uuid(),
  /** Porte e pelagem mudam a duração — disponibilidade sem pet é aproximação. */
  petId: z.uuid(),
  professionalId: z.uuid().optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
})

export const ListAppointmentsQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  professionalId: z.uuid().optional(),
  petId: z.uuid().optional(),
  tutorId: z.uuid().optional(),
  status: AppointmentStatusSchema.optional(),
})

export const AvailabilitySlotSchema = z.object({
  professionalId: z.uuid(),
  professionalName: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  durationMin: z.number().int(),
  priceCents: z.number().int(),
})

export const AvailabilityResponseSchema = z.object({
  slots: z.array(AvailabilitySlotSchema),
  /** AC-02: lista vazia sozinha obriga o tutor a adivinhar a próxima consulta. */
  nextAvailable: z.iso.datetime().nullable(),
  durationMin: z.number().int(),
  priceCents: z.number().int(),
  /**
   * RN-19. Vai junto porque a tela precisa mostrar a hora do **petshop**, não a do
   * navegador de quem está olhando: a recepção que acessa de outro fuso — ou o tutor
   * viajando — leria um horário que não é o do agendamento.
   */
  timezone: z.string(),
})

export const AppointmentResponseSchema = z.object({
  id: z.uuid(),
  status: AppointmentStatusSchema,
  source: AppointmentSourceSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  petId: z.uuid(),
  petName: z.string(),
  tutorId: z.uuid(),
  professionalId: z.uuid(),
  professionalName: z.string(),
  items: z.array(
    z.object({
      serviceId: z.uuid(),
      label: z.string(),
      priceCents: z.number().int(),
      durationMin: z.number().int(),
      addedAtCheckout: z.boolean(),
    }),
  ),
  totalCents: z.number().int(),
  checkinAt: z.iso.datetime().nullable(),
  checkoutAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledLate: z.boolean().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type AppointmentResponse = z.infer<typeof AppointmentResponseSchema>

export const RescheduleSchema = z.object({
  startsAt: z.iso.datetime(),
  /** Remarcar pode trocar de profissional; ausente mantém o mesmo. */
  professionalId: z.uuid().optional(),
  reason: z.string().trim().max(200).optional(),
})

export const RecurrenceScopeSchema = z.enum(['THIS_ONE', 'THIS_AND_FUTURE', 'ALL'])

export const CreateRecurrenceSchema = z.object({
  petId: z.uuid(),
  professionalId: z.uuid(),
  serviceIds: z.array(z.uuid()).min(1).max(10),
  startsAt: z.iso.datetime(),
  /** AC-02: só DAILY, WEEKLY e MONTHLY. A validação fina está em `parseRRule`. */
  rrule: z.string().trim().min(6).max(200),
  until: z.iso.datetime().optional(),
})

export const DayViewQuerySchema = z.object({
  date: z.iso.date(),
})

export const DayAppointmentSchema = z.object({
  id: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: AppointmentStatusSchema,
  petId: z.uuid(),
  petName: z.string(),
  tutorId: z.uuid(),
  services: z.array(z.string()),
  totalCents: z.number().int(),
  alerts: z.array(z.object({ severity: z.string(), label: z.string() })),
  checkinAt: z.iso.datetime().nullable(),
})

export const DayColumnSchema = z.object({
  professionalId: z.uuid(),
  professionalName: z.string(),
  color: z.string().nullable(),
  maxConcurrentPets: z.number().int(),
  shifts: z.array(z.object({ startsAtMin: z.number().int(), endsAtMin: z.number().int() })),
  /** AC-02: a coluna do ausente **aparece**, marcada — sumir assusta a equipe. */
  absent: z.boolean(),
  absenceReason: z.string().nullable(),
  appointments: z.array(DayAppointmentSchema),
  occupancyPercent: z.number().int(),
})

export const DayViewSchema = z.object({
  date: z.string(),
  timezone: z.string(),
  columns: z.array(DayColumnSchema),
})
export type DayView = z.infer<typeof DayViewSchema>
export type DayColumn = z.infer<typeof DayColumnSchema>
export type DayAppointment = z.infer<typeof DayAppointmentSchema>
