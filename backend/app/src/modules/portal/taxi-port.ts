import { withTenant } from '@petshop/db'
import {
  AvailableDriversQuerySchema,
  CreateTaxiRidesSchema,
  TaxiQuoteQuerySchema,
  type TaxiLeg,
  type TaxiRideResponse,
} from '@petshop/shared-types'
import { findAvailableDrivers } from '../taxi/drivers.js'
import { quoteZipCode } from '../taxi/pricing.js'
import { createRides } from '../taxi/rides.js'
import type { ActorContext } from '../taxi/actor.js'

/**
 * A porta para o MOD-TAXI (MOD-PORTAL-07).
 *
 * Era um salto HTTP com contexto assinado. Virou chamada de função na fatia 11, e a linha
 * de corte que motivava o salto continua exatamente onde estava: ler é escolher um recorte,
 * **pedir uma corrida é aplicar regra**. Criar a corrida congela o preço da zona, copia o
 * endereço cifrado, pendura o item que a cobra no agendamento e recalcula o total, publica
 * evento e grava trilha. Reimplementar isso aqui produziria um segundo Taxi Dog, que
 * divergiria do primeiro no dia em que um dos dois mudasse.
 *
 * A leitura do status da corrida, essa sim, é banco direto — está em `taxi.ts`, junto das
 * outras leituras do Portal.
 *
 * **A elevação de permissão continua sendo a parte perigosa, e por isso continua curta.** O
 * papel `TUTOR` não tem `taxi:operate`; estas três operações acontecem como se tivesse. O
 * que as contém:
 *
 * 1. quem chama já provou a posse — o agendamento nasceu do `createBooking` deste mesmo
 *    tutor, no mesmo instante, e o `petId` passou por `assertOwnsPet` antes;
 * 2. `canOverridePrice` é **sempre falso**, e é o que garante que o tutor não defina o preço
 *    da própria corrida. Era `taxi:configure` nunca assinado; hoje é uma constante,
 *    conferível na leitura em vez de espalhada num array de permissões;
 * 3. o ator carrega o `userId` do tutor — a trilha grava quem realmente pediu, e não "o
 *    Portal".
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

/**
 * O ator que o MOD-TAXI recebe, montado do chamador do Portal.
 *
 * Sem `ipAddress` e sem `userAgent`, e a ausência é a de sempre nesta porta: a corrida não
 * guarda prova de origem como o consentimento guarda. Quem precisa dos dois é a
 * `tutor-port`.
 */
function actorOf(caller: TaxiCaller): ActorContext {
  return { tenantId: caller.tenantId, actorUserId: caller.userId }
}

function createInProcessPort(): TaxiPort {
  return {
    quote(caller, zipCode) {
      const query = TaxiQuoteQuerySchema.parse({ zipCode })
      return quoteZipCode(caller.tenantId, query.zipCode)
    },

    async availableDrivers(caller, window) {
      const query = AvailableDriversQuerySchema.parse({
        windowStartsAt: window.startsAt,
        windowEndsAt: window.endsAt,
      })
      return withTenant(caller.tenantId, (tx) =>
        findAvailableDrivers(tx, query.windowStartsAt, query.windowEndsAt),
      )
    },

    async createRides(caller, input) {
      /**
       * Sem `driverId` e sem `priceCentsOverride`.
       *
       * A corrida nasce em `REQUESTED`, na fila sem dono do painel do Taxi Dog — que é onde
       * está a informação para escalar: quem já tem quantos pets na van naquela janela. O
       * tutor escolhendo motorista seria o cliente montando a rota do petshop.
       */
      const parsed = CreateTaxiRidesSchema.parse({
        appointmentId: input.appointmentId,
        legs: input.legs.map((leg) => ({
          leg: leg.leg,
          windowStartsAt: leg.windowStartsAt,
          windowEndsAt: leg.windowEndsAt,
        })),
      })

      return createRides(actorOf(caller), parsed, { canOverridePrice: false })
    },
  }
}

let port: TaxiPort | null = null

export function getTaxiPort(): TaxiPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTaxiPort(next: TaxiPort | null): void {
  port = next
}
