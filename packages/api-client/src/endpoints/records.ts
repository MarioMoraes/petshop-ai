import {
  AllergyCheckResultSchema,
  AllergySchema,
  AttendanceSchema,
  PrescriptionViewSchema,
  PetClinicalSummarySchema,
  CriticalPetsSchema,
  OverdueVaccinesReportSchema,
  TimelinePageSchema,
  MedicalAlertSchema,
  SafetyRecordSchema,
  TemperamentSchema,
  VaccinationCardSchema,
  VaccinationSchema,
  type CreateAllergyInput,
  type CreateVaccinationInput,
  type VoidVaccinationInput,
  type CreateMedicalAlertInput,
  type RecordTemperamentInput,
  type UpdateAllergyInput,
  type UpdateMedicalAlertInput,
  type CreatePrescriptionInput,
  type ProductUsedSchema,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport, toQueryString } from '../transport.js'

export function recordEndpoints({ request, download }: Transport) {
  return {
    // ─── Prontuário de segurança (MOD-PRONT-03/04/05) ──────────────────────

    /** Alergias, temperamento e alertas médicos — o que a aba do pet carrega. */
    getSafetyRecord: (petId: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/safety-record`,
        schema: SafetyRecordSchema,
      }),

    createAllergy: (petId: string, input: CreateAllergyInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/allergies`,
        body: input,
        schema: AllergySchema,
      }),

    updateAllergy: (petId: string, allergyId: string, patch: UpdateAllergyInput) =>
      request({
        method: 'PATCH',
        path: `/v1/pets/${petId}/allergies/${allergyId}`,
        body: patch,
        schema: AllergySchema,
      }),

    // ─── Vacinas (MOD-PRONT-08) ────────────────────────────────────────────

    /** A carteira: o status, a dose vigente de cada vacina e o histórico inteiro. */
    getVaccinationCard: (petId: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/vaccinations`,
        schema: VaccinationCardSchema,
      }),

    createVaccination: (petId: string, input: CreateVaccinationInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/vaccinations`,
        body: input,
        schema: VaccinationSchema,
      }),

    voidVaccination: (petId: string, vaccinationId: string, input: VoidVaccinationInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/vaccinations/${vaccinationId}/void`,
        body: input,
        schema: VaccinationSchema,
      }),

    recordTemperament: (petId: string, input: RecordTemperamentInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/temperament`,
        body: input,
        schema: TemperamentSchema,
      }),

    createMedicalAlert: (petId: string, input: CreateMedicalAlertInput) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/medical-alerts`,
        body: input,
        schema: MedicalAlertSchema,
      }),

    updateMedicalAlert: (petId: string, alertId: string, patch: UpdateMedicalAlertInput) =>
      request({
        method: 'PATCH',
        path: `/v1/pets/${petId}/medical-alerts/${alertId}`,
        body: patch,
        schema: MedicalAlertSchema,
      }),

    // ─── Atendimento e linha do tempo (MOD-PRONT-01/02/09/10) ──────────────

    /**
     * O histórico unificado do pet. O servidor decide **o que** cabe na resposta a
     * partir da permissão de quem pergunta (AC-02): não há filtro a aplicar aqui.
     */
    getPetTimeline: (petId: string, query: { limit?: number; cursor?: string } = {}) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/timeline${toQueryString(query)}`,
        schema: TimelinePageSchema,
      }),

    getPetClinicalSummary: (petId: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/summary`,
        schema: PetClinicalSummarySchema,
      }),

    /** Quantos pets têm alerta crítico ativo, e de que origem. */
    getCriticalPets: () =>
      request({
        method: 'GET',
        path: '/v1/records/reports/critical-pets',
        schema: CriticalPetsSchema,
      }),

    /** Quantos pets ativos têm vacina vigente com a próxima dose vencida. */
    getOverdueVaccines: () =>
      request({
        method: 'GET',
        path: '/v1/records/reports/overdue-vaccines',
        schema: OverdueVaccinesReportSchema,
      }),

    /** A lista dos pets com vacina atrasada, com tutor e telefone, em PDF. */
    downloadOverdueVaccinesPdf: () =>
      download('/v1/records/reports/overdue-vaccines/pdf', 'vacinas-atrasadas.pdf'),

    getAttendance: (id: string) =>
      request({ method: 'GET', path: `/v1/attendances/${id}`, schema: AttendanceSchema }),

    listAttendances: (
      query: { petId?: string; appointmentId?: string; limit?: number; cursor?: string } = {},
    ) =>
      request({
        method: 'GET',
        path: `/v1/attendances${toQueryString(query)}`,
        schema: z.object({
          attendances: z.array(AttendanceSchema),
          nextCursor: z.string().nullable(),
        }),
      }),

    /** Correção dentro da janela de 24h; fora dela o servidor devolve 409. */
    /**
     * `items[].productsUsed` com `productId`, `lotId` e `quantity` dá baixa no estoque pela
     * diferença (MOD-ESTOQUE-07); a linha só com `name` é o texto de sempre.
     */
    updateAttendance: (
      id: string,
      patch: {
        observations?: string | null
        type?: string
        items?: { id: string; productsUsed?: z.input<typeof ProductUsedSchema>[] }[]
      },
    ) =>
      request({
        method: 'PATCH',
        path: `/v1/attendances/${id}`,
        body: patch,
        schema: AttendanceSchema,
      }),

    addAttendanceAddendum: (id: string, input: { body: string; visibility?: string }) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${id}/addendum`,
        body: input,
        schema: AttendanceSchema,
      }),

    addAttendanceNote: (id: string, input: { body: string; visibility?: string }) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${id}/notes`,
        body: input,
        schema: AttendanceSchema,
      }),

    voidAttendance: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${id}/void`,
        body: input,
        schema: AttendanceSchema,
      }),

    // ─── Receituário (MOD-DOC-04) ──────────────────────────────────────────

    /**
     * Emite o receituário do atendimento.
     *
     * O gate real não é a permissão: é o CRMV do profissional ligado ao usuário. Sem
     * ele o servidor devolve 403 `ERR_PRONT_009` — e é o único caminho pelo qual esse
     * código, que existe no catálogo desde o MOD-PRONT, chega à tela.
     */
    createPrescription: (attendanceId: string, input: CreatePrescriptionInput) =>
      request({
        method: 'POST',
        path: `/v1/attendances/${attendanceId}/prescriptions`,
        body: input,
        schema: PrescriptionViewSchema,
      }),

    listPetPrescriptions: (petId: string) =>
      request({
        method: 'GET',
        path: `/v1/pets/${petId}/prescriptions`,
        schema: z.object({ prescriptions: z.array(PrescriptionViewSchema) }),
      }),

    listAttendancePrescriptions: (attendanceId: string) =>
      request({
        method: 'GET',
        path: `/v1/attendances/${attendanceId}/prescriptions`,
        schema: z.object({ prescriptions: z.array(PrescriptionViewSchema) }),
      }),

    /**
     * O detalhe traz a URL assinada de 15 minutos — e pedi-la **é** o download: esta
     * chamada entra na trilha de auditoria do tenant. A listagem não assina nada.
     */
    getPrescription: (id: string) =>
      request({ method: 'GET', path: `/v1/prescriptions/${id}`, schema: PrescriptionViewSchema }),

    /** Anular mantém o arquivo e o número: o que muda é o que o sistema diz sobre ele. */
    voidPrescription: (id: string, input: { reason: string }) =>
      request({
        method: 'POST',
        path: `/v1/prescriptions/${id}/void`,
        body: input,
        schema: PrescriptionViewSchema,
      }),

    /** RN-03: o serviço esbarra em alguma alergia deste pet? */
    checkAllergies: (petId: string, serviceIds: string[]) =>
      request({
        method: 'POST',
        path: `/v1/pets/${petId}/allergy-check`,
        body: { serviceIds },
        schema: AllergyCheckResultSchema,
      }),
  }
}
