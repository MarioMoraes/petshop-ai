import { randomUUID } from 'node:crypto'
import {
  AGENT_SLA_MIN,
  PENDING_MESSAGE_WINDOW_HOURS,
  PendingCountsQuerySchema,
  type PendingCounts,
  type PermissionKey,
  type PlanFeature,
} from '@petshop/shared-types'
import { createParseInput } from '@petshop/service-kit'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { validationError } from '../shared/errors.js'
import { tenantHasFeature } from '../shared/plan.js'

const parseInput = createParseInput(validationError)

/**
 * O sino do Admin numa chamada só — `GET /v1/me/pending`.
 *
 * Era a moldura de **toda** tela do Admin que fazia as nove chamadas, uma por fonte, e a
 * página esperava todas. Cada uma passava pela autenticação e contava no rate limit de
 * quem navegava — foi a moldura que estourou o teto de 300 por minuto em 2026-10-02.
 *
 * **As nove continuam sendo as rotas de sempre, chamadas por dentro** (`app.inject`),
 * com o token de quem pediu. Não há regra copiada aqui: a permissão, o gate de plano, o
 * RLS e a própria contagem são os da rota dona, e duas delas (`pending-count`,
 * `portal-new-count`) só existem dentro do handler. Importar a função de cada módulo
 * seria o import solto entre módulos que o CLAUDE.md proíbe; reescrever, a segunda cópia
 * da regra.
 *
 * O que fica aqui é o que o frontend fazia antes de chamar: **permissão e plano são
 * conferidos antes**, porque pedir e levar 403 gravaria um `PERMISSION_DENIED` na trilha a
 * cada navegação, e o 402 de um recurso fora do plano não é erro de ninguém.
 */

/**
 * A marca das chamadas internas, para o rate limit não contá-las (`app.ts`).
 *
 * Aleatória por processo e nunca enviada para fora dele: quem chega pela rede não tem
 * como conhecê-la. A chamada de fora, a única que alguém fez, continua contando.
 */
export const INTERNAL_CALL_HEADER = 'x-petshop-internal-call'
export const INTERNAL_CALL_TOKEN = randomUUID()

export function isInternalCall(request: FastifyRequest): boolean {
  return request.headers[INTERNAL_CALL_HEADER] === INTERNAL_CALL_TOKEN
}

interface Source<K extends keyof PendingCounts> {
  key: K
  permission: PermissionKey
  feature?: PlanFeature
  url: (now: Date, since: string | undefined) => string
  pick: (body: unknown) => PendingCounts[K]
}

const total = (body: unknown) => (body as { total: number }).total
const itself = <T>(body: unknown) => body as T

/** Na mesma ordem, e com a mesma permissão, que `lib/pendencias.server.ts` usava. */
const SOURCES: { [K in keyof PendingCounts]: Source<K> } = {
  agentHandoffs: {
    key: 'agentHandoffs',
    permission: 'crm:read',
    url: () => `/v1/agent/conversations?status=HANDOFF&waitingOverMinutes=${AGENT_SLA_MIN}&limit=1`,
    pick: total,
  },
  pendingApprovals: {
    key: 'pendingApprovals',
    permission: 'schedule:read_all',
    url: () => '/v1/appointments/pending-count',
    pick: itself,
  },
  newPortalBookings: {
    key: 'newPortalBookings',
    permission: 'schedule:read_all',
    url: (_now, since) =>
      `/v1/appointments/portal-new-count${since ? `?since=${encodeURIComponent(since)}` : ''}`,
    pick: itself,
  },
  deletionRequests: {
    key: 'deletionRequests',
    permission: 'tutor:delete',
    url: () => '/v1/tutors/deletion-requests/count',
    pick: total,
  },
  siteLeads: {
    key: 'siteLeads',
    permission: 'site:read_leads',
    url: () => '/v1/site/leads/count',
    pick: (body) => (body as { newCount: number }).newCount,
  },
  deadMessages: {
    key: 'deadMessages',
    permission: 'crm:read',
    url: (now) => {
      const from = new Date(now.getTime() - PENDING_MESSAGE_WINDOW_HOURS * 60 * 60 * 1000)
      return `/v1/messages/stats?from=${from.toISOString()}&to=${now.toISOString()}`
    },
    pick: (body) => (body as { dead: number }).dead,
  },
  overdueTutors: {
    key: 'overdueTutors',
    permission: 'tutor:read',
    url: () => '/v1/tutors?tag=INADIMPLENTE&limit=1&page=1',
    pick: total,
  },
  inventory: {
    key: 'inventory',
    permission: 'inventory:read',
    feature: 'INVENTORY',
    url: () => '/v1/inventory/alerts',
    pick: itself,
  },
  cash: {
    key: 'cash',
    permission: 'cash:operate',
    feature: 'CASH_REGISTER',
    url: () => '/v1/cash/alerts',
    pick: itself,
  },
}

const NOTHING: PendingCounts = {
  agentHandoffs: null,
  pendingApprovals: null,
  newPortalBookings: null,
  deletionRequests: null,
  siteLeads: null,
  deadMessages: null,
  overdueTutors: null,
  inventory: null,
  cash: null,
}

/**
 * `root` é o app, e não o escopo onde a rota mora: a chamada interna precisa atravessar
 * os hooks de todos os escopos, como faria a de fora.
 */
export function registerPendingRoute(scope: FastifyInstance, root: FastifyInstance): void {
  scope.get('/v1/me/pending', async (request): Promise<PendingCounts> => {
    const { since } = parseInput(PendingCountsQuerySchema, request.query)
    const auth = request.auth
    // Quem ainda não tem estabelecimento não tem pendência — e o sino não aparece.
    if (!auth?.tenantId) return NOTHING
    const tenantId = auth.tenantId

    const now = new Date()
    const entries = await Promise.all(
      (Object.keys(SOURCES) as (keyof PendingCounts)[]).map(async (key) => {
        const source = SOURCES[key] as Source<typeof key>
        if (!auth.permissions.includes(source.permission)) return [key, null] as const
        if (source.feature && !(await tenantHasFeature(tenantId, source.feature))) {
          return [key, null] as const
        }

        const response = await root.inject({
          method: 'GET',
          url: source.url(now, since),
          headers: {
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
            [INTERNAL_CALL_HEADER]: INTERNAL_CALL_TOKEN,
            // O mesmo id da chamada de fora: no log, as dez linhas são uma navegação só.
            'x-request-id': request.id,
          },
        })
        if (response.statusCode !== 200) {
          // O sino é enfeite da moldura: uma fonte fora do ar apaga a linha dela, e a tela
          // de destino é que dá a notícia ruim direito.
          request.log.warn({ source: key, status: response.statusCode }, 'pendência indisponível')
          return [key, null] as const
        }
        return [key, source.pick(response.json())] as const
      }),
    )

    return Object.fromEntries(entries) as PendingCounts
  })
}
