import { signServiceHeaders } from '@petshop/service-auth'
import {
  AppError,
  ERROR_CATALOG,
  type ErrorCode,
  type FieldError,
  type PermissionKey,
  type TaxiLeg,
  type TaxiRideResponse,
} from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'
import { upstreamUnavailable } from '../../lib/errors.js'

/**
 * A porta para o taxidog-service (MOD-PORTAL-07).
 *
 * **Por que HTTP, se o BFF lê o banco direto no resto do módulo.** É a mesma linha de
 * corte da `scheduling-port`: ler é escolher um recorte, pedir uma corrida é aplicar
 * regra. Criar a corrida congela o preço da zona, copia o endereço cifrado, pendura o
 * item que a cobra no agendamento e recalcula o total, publica evento e grava trilha.
 * Reimplementar isso aqui produziria um segundo Taxi Dog, que divergiria do primeiro no
 * dia em que um dos dois mudasse.
 *
 * A leitura do status da corrida, essa sim, é banco direto — está em `taxi.ts`, junto
 * das outras leituras do Portal.
 *
 * **A elevação de permissão é a parte perigosa, e por isso é curta.** O papel `TUTOR`
 * não tem `taxi:operate`; esta porta assina um contexto que tem. O que a contém:
 *
 * 1. quem chama já provou a posse — o agendamento nasceu do `createBooking` deste mesmo
 *    tutor, no mesmo instante, e o `petId` passou por `assertOwnsPet` antes;
 * 2. `taxi:configure` **nunca** é assinado, e é o que garante que o tutor não defina o
 *    preço da própria corrida (`priceCentsOverride` exige essa permissão no domínio);
 * 3. o `userId` assinado é o do tutor — a trilha do outro lado grava quem realmente
 *    pediu, e não "o Portal".
 */

export interface TaxiCaller {
  tenantId: string
  clerkUserId: string
  userId?: string | undefined
}

export interface TaxiQuote {
  zipCode: string
  priceCents: number
  priceSource: string
  zone: { id: string; name: string } | null
}

export interface TaxiDriverSlot {
  id: string
  displayName: string
  remaining: number
}

export interface TaxiLegRequest {
  leg: TaxiLeg
  windowStartsAt: string
  windowEndsAt: string
}

export interface TaxiPort {
  quote(caller: TaxiCaller, zipCode: string): Promise<TaxiQuote>
  availableDrivers(
    caller: TaxiCaller,
    window: { startsAt: string; endsAt: string },
  ): Promise<TaxiDriverSlot[]>
  createRides(
    caller: TaxiCaller,
    input: { appointmentId: string; legs: TaxiLegRequest[] },
  ): Promise<TaxiRideResponse[]>
}

const REQUEST_TIMEOUT_MS = 10_000

/**
 * O mínimo, e o mesmo para as três operações.
 *
 * `taxi:operate` é o que a recepção usa para cotar, consultar motorista e criar corrida.
 * `taxi:configure` fica de fora: é a permissão do preço manual e da configuração do
 * módulo, e nada do Portal precisa dela.
 */
const TAXI_PERMISSIONS: PermissionKey[] = ['taxi:operate']

interface ProblemBody {
  code?: string
  detail?: string
  [key: string]: unknown
}

function createHttpPort(): TaxiPort {
  async function call<T>(
    caller: TaxiCaller,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const env = loadEnv()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let response: Response
    try {
      const headers = signServiceHeaders(
        {
          clerkUserId: caller.clerkUserId,
          ...(caller.userId ? { userId: caller.userId } : {}),
          tenantId: caller.tenantId,
          permissions: [...TAXI_PERMISSIONS],
        },
        env.INTERNAL_SERVICE_SECRET,
      )

      response = await fetch(`${env.TAXIDOG_SERVICE_URL}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
    } catch (error) {
      logger.error({ err: error, path }, 'falha ao falar com o taxidog-service')
      throw upstreamUnavailable()
    } finally {
      clearTimeout(timeout)
    }

    const payload = (await response.json().catch(() => null)) as ProblemBody | null

    if (!response.ok) {
      /**
       * Código desconhecido vira 502, como na porta da agenda: `new AppError(code)` lê o
       * status do catálogo, e um código de fora dele estouraria dentro do construtor.
       * Acontece de verdade quando os dois serviços sobem em versões diferentes.
       */
      const conhecido = payload?.code !== undefined && payload.code in ERROR_CATALOG

      if (response.status >= 500 || !conhecido) {
        logger.error(
          { status: response.status, path, detail: payload?.detail },
          'taxidog-service recusou a operação do Portal',
        )
        throw upstreamUnavailable()
      }

      const {
        code,
        detail,
        title: _title,
        status: _status,
        type: _type,
        fields,
        ...extra
      } = payload
      throw new AppError(
        code as ErrorCode,
        typeof detail === 'string' ? detail : 'Não foi possível concluir',
        Array.isArray(fields) ? (fields as FieldError[]) : undefined,
        Object.keys(extra).length > 0 ? extra : undefined,
      )
    }

    return payload as T
  }

  return {
    quote(caller, zipCode) {
      return call(caller, 'GET', `/v1/taxi/quote?zipCode=${encodeURIComponent(zipCode)}`)
    },

    async availableDrivers(caller, window) {
      const query = new URLSearchParams({
        windowStartsAt: window.startsAt,
        windowEndsAt: window.endsAt,
      })
      const body = await call<{ items: TaxiDriverSlot[] }>(
        caller,
        'GET',
        `/v1/taxi/drivers/available?${query.toString()}`,
      )
      return body.items
    },

    async createRides(caller, input) {
      /**
       * Sem `driverId` e sem `priceCentsOverride`.
       *
       * A corrida nasce em `REQUESTED`, na fila sem dono do painel do Taxi Dog — que é
       * onde está a informação para escalar: quem já tem quantos pets na van naquela
       * janela. O tutor escolhendo motorista seria o cliente montando a rota do petshop.
       */
      const body = await call<{ items: TaxiRideResponse[] }>(
        caller,
        'POST',
        '/v1/taxi/rides',
        {
          appointmentId: input.appointmentId,
          legs: input.legs.map((leg) => ({
            leg: leg.leg,
            windowStartsAt: leg.windowStartsAt,
            windowEndsAt: leg.windowEndsAt,
          })),
        },
      )
      return body.items
    },
  }
}

let port: TaxiPort | null = null

export function getTaxiPort(): TaxiPort {
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTaxiPort(next: TaxiPort | null): void {
  port = next
}
