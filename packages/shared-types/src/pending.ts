import { z } from 'zod'
import { CashAlertsSchema } from './cash.js'
import { InventoryAlertsSchema } from './inventory.js'
import { NewPortalBookingsSchema, PendingApprovalsSchema } from './scheduling.js'

/**
 * O sino do Admin numa resposta só — `GET /v1/me/pending`.
 *
 * Eram nove chamadas por navegação, uma por fonte, e a moldura esperava todas antes de a
 * página aparecer; cada uma passava pela autenticação e contava no rate limit de quem
 * navegava. O backend agora as faz por dentro e devolve o conjunto. Cada fonte continua
 * caindo para `null` sozinha: sem permissão, sem o recurso no plano, ou fora do ar.
 */

/**
 * Janela das falhas de mensagem: 24 horas corridas, e não o dia do calendário.
 *
 * Aqui, e não no frontend, porque quem **aplica** a janela agora é o servidor; a linha
 * do sino continua a **anunciá-la**, e o número mora num lugar só para o texto não
 * começar a mentir sobre o dado.
 */
export const PENDING_MESSAGE_WINDOW_HOURS = 24

export const PendingCountsQuerySchema = z.object({
  /** A marca de lido do vínculo (`memberships.portal_bookings_seen_at`), se houver. */
  since: z.iso.datetime().optional(),
})
export type PendingCountsQuery = z.infer<typeof PendingCountsQuerySchema>

export const PendingCountsSchema = z.object({
  /** Conversas do agente esperando a recepção há mais de `AGENT_SLA_MIN`. */
  agentHandoffs: z.number().int().nullable(),
  pendingApprovals: PendingApprovalsSchema.nullable(),
  newPortalBookings: NewPortalBookingsSchema.nullable(),
  deletionRequests: z.number().int().nullable(),
  siteLeads: z.number().int().nullable(),
  /** Mensagens em `DEAD` na janela de `PENDING_MESSAGE_WINDOW_HOURS`. */
  deadMessages: z.number().int().nullable(),
  overdueTutors: z.number().int().nullable(),
  inventory: InventoryAlertsSchema.nullable(),
  cash: CashAlertsSchema.nullable(),
})
export type PendingCounts = z.infer<typeof PendingCountsSchema>
