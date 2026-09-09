import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  todayIn,
  zonedDayRange,
  DEFAULT_TIMEZONE,
  type ListTaxiRidesQuery,
} from '@petshop/shared-types'
import { notFound } from './errors.js'
import { openCipher } from './crypto.js'
import { toRideDto, type TaxiRideDto } from './mapper.js'
import type { ActorContext } from './actor.js'

/** Leitura de corridas (§5). O corte por papel é aplicado nas rotas, não aqui. */

export interface RideScope {
  /** RN-19: o motorista só enxerga as próprias corridas. */
  driverId?: string | undefined
  /** O tutor, quando o Portal chegar, só enxerga as dele. */
  tutorId?: string | undefined
}

async function loadTimezone(tx: TenantTransaction): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}

export interface RidePage {
  items: TaxiRideDto[]
  page: number
  limit: number
  total: number
}

export async function listRides(
  actor: ActorContext,
  query: ListTaxiRidesQuery,
  scope: RideScope = {},
): Promise<RidePage> {
  return withTenant(actor.tenantId, async (tx) => {
    const timezone = await loadTimezone(tx)

    // RN-12: "hoje" é o dia do estabelecimento, não o do servidor nem o do navegador.
    let windowFilter: { gte?: Date; lte?: Date } | undefined
    if (query.date) {
      const { from, to } = zonedDayRange(query.date, timezone)
      windowFilter = { gte: from, lte: to }
    } else if (query.from || query.to) {
      windowFilter = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      }
    }

    const where = {
      ...(windowFilter ? { windowStartsAt: windowFilter } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.leg ? { leg: query.leg } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      // O escopo do papel vence o filtro pedido: um motorista que passe
      // `?driverId=outro` continua vendo só as próprias corridas.
      ...(scope.driverId ? { driverId: scope.driverId } : query.driverId ? { driverId: query.driverId } : {}),
      ...(scope.tutorId ? { tutorId: scope.tutorId } : query.tutorId ? { tutorId: query.tutorId } : {}),
      ...(query.unassigned ? { driverId: null, status: 'REQUESTED' as const } : {}),
    }

    const [rows, total] = await Promise.all([
      tx.taxiRide.findMany({
        where,
        orderBy: [{ windowStartsAt: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.taxiRide.count({ where }),
    ])

    const cipher = await openCipher(tx, actor.tenantId)
    return {
      items: rows.map((row) => toRideDto(row, cipher)),
      page: query.page,
      limit: query.limit,
      total,
    }
  })
}

export async function getRide(
  actor: ActorContext,
  rideId: string,
  scope: RideScope = {},
): Promise<TaxiRideDto> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.taxiRide.findFirst({
      where: {
        id: rideId,
        ...(scope.driverId ? { driverId: scope.driverId } : {}),
        ...(scope.tutorId ? { tutorId: scope.tutorId } : {}),
      },
    })
    // O 404 é deliberado onde caberia 403: dizer "existe, mas não é sua" já vaza que
    // a corrida existe naquele tenant.
    if (!row) throw notFound()

    const cipher = await openCipher(tx, actor.tenantId)
    return toRideDto(row, cipher)
  })
}

/** O dia do estabelecimento, para as rotas que aceitam `?date=` opcional. */
export async function resolveToday(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => todayIn(await loadTimezone(tx)))
}
