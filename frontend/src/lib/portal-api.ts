import 'server-only'
import { auth } from '@clerk/nextjs/server'
import { headers } from 'next/headers'
import { resolveHost } from '@/lib/host'
import { appDomain } from '@/lib/domain'
import type {
  PortalAppointmentDetail,
  PortalAppointmentsResponse,
  PortalAvailabilityResponse,
  PortalBookingServicesResponse,
  PortalChallengeResponse,
  PortalContextResponse,
  PortalFinanceResponse,
  PortalMessagesResponse,
  PortalPetDetail,
  PortalPreferencesResponse,
  PortalPetSummary,
  PortalReceiptResponse,
  PortalStatementResponse,
  PortalTaxiOffer,
  PortalTaxiRide,
  PortalTenantResponse,
  PortalTimelineResponse,
  UpdateOwnPetInput,
  UpdatePortalPreferenceInput,
} from '@petshop/shared-types'

/**
 * Cliente do Portal, para uso no servidor.
 *
 * Separado de `lib/api.ts` por uma diferença que não é de estilo: **o Portal precisa
 * dizer de que petshop se fala**, e o Admin não. A sessão da equipe carrega a
 * Organization do Clerk, e dela o gateway resolve o tenant; o tutor não é membro de
 * organização nenhuma, então quem sabe o petshop é o host que este processo acabou de
 * servir — `petshopdojoao.{APP_DOMAIN}`. O slug sai daqui e vai no header.
 *
 * O token continua morando no servidor, como no Admin: o browser nunca fala com o
 * gateway.
 */

const baseUrl =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

const TENANT_SLUG_HEADER = 'x-petshop-tenant-slug'
const REQUEST_TIMEOUT_MS = 15_000

/**
 * O petshop deste endereço.
 *
 * Em desenvolvimento não há subdomínio (`localhost:3002` é sempre Admin), então o slug
 * vem de `PORTAL_DEV_SLUG` — é o que permite abrir o Portal na máquina de quem
 * desenvolve sem mexer no `/etc/hosts` a cada tenant novo.
 */
export async function portalSlug(): Promise<string | null> {
  const host = (await headers()).get('host') ?? ''
  const resolved = resolveHost(host, appDomain())
  if (resolved.slug) return resolved.slug
  return process.env.PORTAL_DEV_SLUG ?? null
}

export class PortalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * O resto do `problem+json`, sem a moldura.
     *
     * O BFF manda contexto junto de vários erros — os horários próximos de um conflito,
     * os alertas clínicos a reconhecer, o valor da taxa, as janelas alternativas do
     * leva-e-traz. Sem este campo, a tela recebia a frase e jogava fora o que a tornava
     * acionável.
     */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }

  /** A lista de horários que o 409 de van cheia oferece (AC-04 de MOD-PORTAL-07). */
  get alternativeStartsAt(): string[] | undefined {
    const value = this.extra.alternativeStartsAt
    return Array.isArray(value) ? (value as string[]) : undefined
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  path: string
  body?: unknown
  /** Rota pública do Portal: a identidade visual, antes de haver sessão. */
  anonymous?: boolean
}

async function request<T>(options: RequestOptions): Promise<T> {
  const slug = await portalSlug()
  if (!slug) {
    throw new PortalError(404, 'ERR_PORTAL_001', 'Estabelecimento não encontrado')
  }

  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    [TENANT_SLUG_HEADER]: slug,
  }

  if (!options.anonymous) {
    const session = await auth()
    // O template nomeado publica o claim que o gateway compara; sem ele, cai no token
    // de sessão padrão. Mesma regra do Admin (ver `docs/setup-clerk.md`).
    const token =
      (await session.getToken({ template: 'petshop' }).catch(() => null)) ??
      (await session.getToken())
    if (token) requestHeaders.authorization = `Bearer ${token}`
  }

  /**
   * Teto por requisição, pelo mesmo motivo de `lib/api.ts`: um `await` que nunca volta
   * dentro de um Server Component deixa a página **em branco, sem erro nenhum** — nem
   * overlay, nem linha de log —, e não há o que investigar depois.
   */
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}${options.path}`, {
      method: options.method ?? 'GET',
      headers: requestHeaders,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    })

    const payload = (await response.json().catch(() => null)) as
      | ({ code?: string; detail?: string } & Record<string, unknown>)
      | null

    if (!response.ok) {
      // A moldura do problem+json fica de fora; o que interessa é o contexto do erro.
      const moldura = new Set(['code', 'detail', 'title', 'status', 'type'])
      const extra = Object.fromEntries(
        Object.entries(payload ?? {}).filter(([chave]) => !moldura.has(chave)),
      )

      throw new PortalError(
        response.status,
        payload?.code ?? 'ERR_PORTAL_010',
        payload?.detail ?? 'Não foi possível concluir agora. Tente novamente.',
        extra,
      )
    }

    return payload as T
  } catch (error) {
    if (error instanceof PortalError) throw error
    if (controller.signal.aborted) {
      throw new PortalError(504, 'ERR_PORTAL_010', 'O sistema demorou para responder.')
    }
    throw new PortalError(502, 'ERR_PORTAL_010', 'Não foi possível falar com o sistema.')
  } finally {
    clearTimeout(timeout)
  }
}

export function readPortalTenant(): Promise<PortalTenantResponse> {
  return request({ path: '/portal/v1/tenant', anonymous: true })
}

export function readPortalContext(): Promise<PortalContextResponse> {
  return request({ path: '/portal/v1/me' })
}

export function requestAccessCode(body: {
  identifier: string
  website?: string
}): Promise<PortalChallengeResponse> {
  return request({ method: 'POST', path: '/portal/v1/access/challenge', body })
}

export function verifyAccessCode(body: {
  challengeId: string
  code: string
}): Promise<PortalContextResponse> {
  return request({ method: 'POST', path: '/portal/v1/access/verify', body })
}

export function readOwnPets(): Promise<{ pets: PortalPetSummary[] }> {
  return request({ path: '/portal/v1/pets' })
}

export function readOwnPet(petId: string): Promise<PortalPetDetail> {
  return request({ path: `/portal/v1/pets/${petId}` })
}

export function updateOwnPet(
  petId: string,
  body: UpdateOwnPetInput,
): Promise<PortalPetDetail> {
  return request({ method: 'PATCH', path: `/portal/v1/pets/${petId}`, body })
}

/**
 * O histórico, paginado por cursor.
 *
 * O cursor é a hora do último atendimento entregue, e vai na URL já codificado: um
 * `+` de fuso horário não sobrevive à query string sem isso, e a página seguinte
 * voltaria vazia sem erro nenhum.
 */
export function readOwnPetTimeline(
  petId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<PortalTimelineResponse> {
  const query = new URLSearchParams()
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.limit) query.set('limit', String(options.limit))
  const suffix = query.size > 0 ? `?${query.toString()}` : ''

  return request({ path: `/portal/v1/pets/${petId}/timeline${suffix}` })
}

// ─── MOD-PORTAL-05 — Agendamento Online ──────────────────────────────────────

export function readBookableServices(petId: string): Promise<PortalBookingServicesResponse> {
  return request({ path: `/portal/v1/booking/services?petId=${petId}` })
}

/**
 * Os horários de um dia.
 *
 * `date` é dia civil no fuso do petshop, e não um instante: quem escolhe escolhe um
 * dia, e converter para UTC aqui jogaria a madrugada para o dia anterior.
 */
export function readAvailability(query: {
  petId: string
  serviceIds: string[]
  date: string
}): Promise<PortalAvailabilityResponse> {
  const search = new URLSearchParams({
    petId: query.petId,
    serviceIds: query.serviceIds.join(','),
    date: query.date,
  })
  return request({ path: `/portal/v1/booking/availability?${search.toString()}` })
}

export interface CreatedBookingResponse {
  id: string
  status: string
  startsAt: string
  endsAt: string
  petName: string
  professionalName: string
  services: string[]
  totalCents: number
  awaitingApproval: boolean
  duplicate: boolean
  taxi: PortalTaxiRide[]
  taxiWarning: string | null
}

export function createBooking(body: {
  petId: string
  serviceIds: string[]
  startsAt: string
  professionalId: string
  acknowledgedAlerts?: boolean
  taxi?: { pickup: boolean; dropoff: boolean }
}): Promise<CreatedBookingResponse> {
  return request({ method: 'POST', path: '/portal/v1/booking', body })
}

// ─── MOD-PORTAL-07 — Taxi Dog no Agendamento ─────────────────────────────────

/**
 * A oferta de leva-e-traz para este tutor.
 *
 * Não depende do pet nem do horário escolhido: o preço é do **CEP** do endereço
 * primário, e é por isso que a pergunta cabe uma vez só por tela em vez de a cada
 * mudança de serviço.
 */
export function readTaxiOffer(): Promise<PortalTaxiOffer> {
  return request({ path: '/portal/v1/booking/taxi' })
}

// ─── MOD-PORTAL-06 — Meus Agendamentos ───────────────────────────────────────

export function readOwnAppointments(
  options: { cursor?: string; limit?: number } = {},
): Promise<PortalAppointmentsResponse> {
  const query = new URLSearchParams()
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.limit) query.set('limit', String(options.limit))
  const suffix = query.size > 0 ? `?${query.toString()}` : ''

  return request({ path: `/portal/v1/appointments${suffix}` })
}

export function readOwnAppointment(id: string): Promise<PortalAppointmentDetail> {
  return request({ path: `/portal/v1/appointments/${id}` })
}

export function cancelOwnAppointment(
  id: string,
  body: { acknowledgeFee: boolean },
): Promise<PortalAppointmentDetail> {
  return request({ method: 'POST', path: `/portal/v1/appointments/${id}/cancel`, body })
}

export function rescheduleOwnAppointment(
  id: string,
  body: { startsAt: string; professionalId: string },
): Promise<PortalAppointmentDetail> {
  return request({ method: 'POST', path: `/portal/v1/appointments/${id}/reschedule`, body })
}

// ─── MOD-PORTAL-08 — Extrato e Recibos ───────────────────────────────────────

export function readOwnFinance(): Promise<PortalFinanceResponse> {
  return request({ path: '/portal/v1/finance' })
}

/**
 * O extrato, paginado por página.
 *
 * Por página e não por cursor, ao contrário do histórico do pet: os lançamentos são
 * ordenados por data do fato gerador, que **repete** quando três serviços do mesmo dia
 * entram juntos. Um cursor por data pularia linhas ou as repetiria.
 */
export function readOwnStatement(
  options: { page?: number; limit?: number } = {},
): Promise<PortalStatementResponse> {
  const query = new URLSearchParams()
  if (options.page) query.set('page', String(options.page))
  if (options.limit) query.set('limit', String(options.limit))
  const suffix = query.size > 0 ? `?${query.toString()}` : ''

  return request({ path: `/portal/v1/finance/statement${suffix}` })
}

export function readOwnReceipt(paymentId: string): Promise<PortalReceiptResponse> {
  return request({ path: `/portal/v1/finance/receipts/${paymentId}` })
}

// ─── MOD-PORTAL-10 — Central de Comunicação ──────────────────────────────────

/**
 * O histórico de mensagens, paginado por página como o extrato.
 *
 * Pelo mesmo motivo de lá: uma campanha enfileira centenas de mensagens no mesmo
 * instante, e um cursor por data pularia ou repetiria linhas dentro do lote.
 */
export function readOwnMessages(
  options: { page?: number; limit?: number } = {},
): Promise<PortalMessagesResponse> {
  const query = new URLSearchParams()
  if (options.page) query.set('page', String(options.page))
  if (options.limit) query.set('limit', String(options.limit))
  const suffix = query.size > 0 ? `?${query.toString()}` : ''

  return request({ path: `/portal/v1/messages${suffix}` })
}

export function readOwnPreferences(): Promise<PortalPreferencesResponse> {
  return request({ path: '/portal/v1/preferences' })
}

/** Um canal por chamada: cada clique é uma transição, e a trilha é append-only. */
export function updateOwnPreference(
  body: UpdatePortalPreferenceInput,
): Promise<PortalPreferencesResponse> {
  return request({ method: 'PATCH', path: '/portal/v1/preferences', body })
}
