import { z } from 'zod'

/**
 * MOD-ADMIN — contratos da administração da plataforma
 * (PRD observabilidade_admin_14 §5).
 *
 * O que este arquivo descreve é a superfície da **equipe PetShop AI**, não a de um
 * estabelecimento. Ela vive sob `/platform/v1`, resolve sessão de outro jeito — token sem
 * Organization mais linha viva em `platform_admins` — e nunca toca dado de negócio sem a
 * autorização do controlador, que é o MOD-ADMIN-02.
 */

/**
 * A concessão do papel de plataforma (MOD-ADMIN-01, AC-04).
 *
 * O e-mail é o identificador porque é o que a pessoa sabe dizer; o produto o converte em
 * `email_hash` antes de procurar, que é como toda busca por e-mail funciona aqui — a
 * coluna em claro não existe.
 */
export const GrantPlatformAdminSchema = z.strictObject({
  email: z.email().max(254),
})
export type GrantPlatformAdminInput = z.output<typeof GrantPlatformAdminSchema>

export const PlatformAdminResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  fullName: z.string(),
  grantedAt: z.iso.datetime(),
  /** Nulo só na linha de bootstrap: não havia quem concedesse. */
  grantedBy: z.uuid().nullable(),
})
export type PlatformAdminResponse = z.output<typeof PlatformAdminResponseSchema>

/**
 * O pedido de acesso do suporte (MOD-ADMIN-02, AC-01).
 *
 * `reason` tem mínimo de dez caracteres, e não é rigor gratuito: é o texto que o
 * administrador do petshop lê para decidir se aprova. "suporte" não é motivo — "chamado
 * #482, tutor relata recibo não recebido" é.
 */
export const RequestSupportAccessSchema = z.strictObject({
  reason: z.string().trim().min(10).max(300),
})
export type RequestSupportAccessInput = z.output<typeof RequestSupportAccessSchema>

/**
 * A aprovação, com o prazo que o estabelecimento escolhe.
 *
 * O teto do schema é 168h (uma semana) e o do servidor é `SUPPORT_GRANT_MAX_HOURS`, que é
 * menor. Os dois existem: o schema recusa o absurdo, e o ambiente decide a política.
 */
export const ApproveSupportAccessSchema = z.strictObject({
  hours: z.coerce.number().int().min(1).max(168).default(24),
})
export type ApproveSupportAccessInput = z.output<typeof ApproveSupportAccessSchema>

export const SUPPORT_GRANT_STATUSES = [
  'REQUESTED',
  'ACTIVE',
  'DENIED',
  'EXPIRED',
  'REVOKED',
] as const

export const SupportGrantResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(SUPPORT_GRANT_STATUSES),
  reason: z.string(),
  requestedBy: z.object({ userId: z.uuid(), fullName: z.string() }),
  requestedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
})
export type SupportGrantResponse = z.output<typeof SupportGrantResponseSchema>
