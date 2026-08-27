import { withTenant, type TenantTransaction } from '@petshop/db'
import { DEFAULT_TIMEZONE, todayIn, zonedDayRange } from '@petshop/shared-types'
import { logger } from '../../lib/logger.js'
import { openCipher, type TaxiCipher } from './crypto.js'
import { toRideDto, type TaxiRideDto } from './mapper.js'
import type { ActorContext } from './actor.js'

/**
 * Painel do dia e rota do motorista (MOD-TAXI-07).
 *
 * As duas leituras respondem a perguntas diferentes e por isso não são a mesma
 * consulta com um filtro: o painel pergunta "o dia inteiro está coberto?" e precisa
 * da **fila sem dono** no topo; a rota pergunta "para onde eu vou agora?" e precisa
 * da ordem das paradas com endereço e telefone.
 *
 * O dia é recortado pelo fuso do tenant (RN-12), nunca pelo do servidor.
 */

async function loadTimezone(tx: TenantTransaction): Promise<string> {
  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  return settings?.timezone ?? DEFAULT_TIMEZONE
}

/** Status que ainda ocupam o painel. Encerradas aparecem, mas separadas. */
const OPEN_STATUSES = ['REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD'] as const

export interface DriverLane {
  driverId: string
  displayName: string
  rides: TaxiRideDto[]
  /** Corridas com janela vencida e status não terminal. */
  overdue: number
}

export interface TaxiBoard {
  date: string
  timezone: string
  /** A faixa do topo: corrida sem motorista é pet esperando na calçada. */
  unassigned: TaxiRideDto[]
  lanes: DriverLane[]
  closed: TaxiRideDto[]
  totals: {
    rides: number
    unassigned: number
    overdue: number
    delivered: number
  }
}

export async function getBoard(actor: ActorContext, date?: string): Promise<TaxiBoard> {
  return withTenant(actor.tenantId, async (tx) => {
    const timezone = await loadTimezone(tx)
    const day = date ?? todayIn(timezone)
    const { from, to } = zonedDayRange(day, timezone)

    const rows = await tx.taxiRide.findMany({
      where: { windowStartsAt: { gte: from, lte: to } },
      orderBy: [{ windowStartsAt: 'asc' }, { createdAt: 'asc' }],
    })

    const cipher = await openCipher(tx, actor.tenantId)
    const now = new Date()

    const drivers = await tx.professional.findMany({
      where: { roleKey: 'DRIVER', deletedAt: null },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    })
    const nameById = new Map(drivers.map((driver) => [driver.id, driver.displayName]))

    const unassigned: TaxiRideDto[] = []
    const closed: TaxiRideDto[] = []
    const byDriver = new Map<string, TaxiRideDto[]>()
    let overdueTotal = 0
    let delivered = 0

    for (const row of rows) {
      const dto = toRideDto(row, cipher)
      const open = (OPEN_STATUSES as readonly string[]).includes(row.status)

      if (row.status === 'DELIVERED') delivered += 1
      if (open && row.windowEndsAt < now) overdueTotal += 1

      if (!open) {
        closed.push(dto)
        continue
      }
      if (!row.driverId) {
        unassigned.push(dto)
        continue
      }
      const lane = byDriver.get(row.driverId) ?? []
      lane.push(dto)
      byDriver.set(row.driverId, lane)
    }

    const lanes: DriverLane[] = [...byDriver.entries()].map(([driverId, rides]) => ({
      driverId,
      displayName: nameById.get(driverId) ?? 'Motorista removido',
      rides,
      overdue: rides.filter(
        (ride) => new Date(ride.windowEndsAt) < now && ride.status !== 'DELIVERED',
      ).length,
    }))
    lanes.sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))

    return {
      date: day,
      timezone,
      unassigned,
      lanes,
      closed,
      totals: {
        rides: rows.length,
        unassigned: unassigned.length,
        overdue: overdueTotal,
        delivered,
      },
    }
  })
}

/**
 * O que o motorista precisa saber antes de abrir a porta da van.
 *
 * Não é o prontuário: é o recorte de manuseio. `requiresMuzzle` e
 * `requiresTwoHandlers` vêm do temperamento porque são a informação que decide se ele
 * desce sozinho da van — e o motorista é quem põe a mão no pet **antes** de qualquer
 * pessoa do salão (RN-08). O alerta é informativo e nunca bloqueia a corrida.
 */
export interface HandlingAlert {
  kind: 'MEDICAL' | 'TEMPERAMENT'
  severity: string
  label: string
}

export interface RouteStop extends TaxiRideDto {
  petName: string
  tutorName: string
  tutorPhone: string | null
  alerts: HandlingAlert[]
  requiresMuzzle: boolean
  requiresTwoHandlers: boolean
  /** RN-10: a volta ainda travada aparece esmaecida, não escondida (AC-03). */
  waitingForAttendance: boolean
}

const TEMPERAMENT_LABELS: Record<string, string> = {
  DOCILE: 'Dócil',
  ANXIOUS: 'Ansioso',
  FEARFUL: 'Medroso',
  REACTIVE: 'Reativo',
  AGGRESSIVE: 'Agressivo',
  UNKNOWN: 'Temperamento não avaliado',
}

/** Só o que muda o manuseio. Um "dócil" na tela do motorista é ruído. */
const RISKY_TEMPERAMENTS = ['REACTIVE', 'AGGRESSIVE', 'FEARFUL'] as const

/**
 * O telefone do tutor, ou nulo se a decifragem falhar.
 *
 * Deliberadamente tolerante, e só aqui: a rota é a tela que o motorista abre na rua, e
 * um telefone corrompido em **uma** parada não pode apagar as outras sete. O resto do
 * serviço deixa a falha subir — é numa leitura de escritório que uma DEK errada
 * precisa aparecer como erro, não como campo vazio.
 */
function safePhone(cipher: TaxiCipher, payload: string, tutorId: string): string | null {
  try {
    return cipher.decrypt(payload)
  } catch (error) {
    logger.error({ err: error, tutorId }, 'falha ao decifrar o telefone do tutor na rota')
    return null
  }
}

/**
 * A rota do motorista.
 *
 * Traz **apenas as corridas do próprio motorista e apenas do dia pedido** (§9): é o
 * ponto do sistema em que mais dado pessoal chega a um dispositivo fora do balcão, e
 * um "todas as corridas" no celular de quem está na rua é o vazamento esperando
 * acontecer.
 *
 * A corrida de volta ainda não liberada vem na lista com `waitingForAttendance`, e
 * não some: o motorista precisa saber que ela existe para planejar a tarde.
 */
export async function getDriverRoute(
  actor: ActorContext,
  driverId: string,
  date?: string,
): Promise<{ date: string; timezone: string; stops: RouteStop[] }> {
  return withTenant(actor.tenantId, async (tx) => {
    const timezone = await loadTimezone(tx)
    const day = date ?? todayIn(timezone)
    const { from, to } = zonedDayRange(day, timezone)

    const rows = await tx.taxiRide.findMany({
      where: {
        driverId,
        windowStartsAt: { gte: from, lte: to },
        status: { notIn: ['CANCELLED'] },
      },
      orderBy: [{ windowStartsAt: 'asc' }],
    })

    const cipher = await openCipher(tx, actor.tenantId)

    const petIds = [...new Set(rows.map((row) => row.petId))]
    const tutorIds = [...new Set(rows.map((row) => row.tutorId))]

    const [pets, tutors, medical, temperaments] = await Promise.all([
      tx.pet.findMany({ where: { id: { in: petIds } }, select: { id: true, name: true } }),
      tx.tutor.findMany({
        where: { id: { in: tutorIds } },
        select: { id: true, fullName: true, socialName: true, phoneEncrypted: true },
      }),
      tx.medicalAlert.findMany({
        where: { petId: { in: petIds }, active: true },
        select: { petId: true, severity: true, condition: true },
      }),
      tx.temperament.findMany({
        where: { petId: { in: petIds }, isCurrent: true },
        select: {
          petId: true,
          classification: true,
          requiresMuzzle: true,
          requiresTwoHandlers: true,
        },
      }),
    ])

    const petById = new Map(pets.map((pet) => [pet.id, pet.name]))
    const tutorById = new Map(tutors.map((tutor) => [tutor.id, tutor]))
    const temperamentByPet = new Map(temperaments.map((row) => [row.petId, row]))

    const alertsByPet = new Map<string, HandlingAlert[]>()
    const push = (petId: string, alert: HandlingAlert) => {
      const list = alertsByPet.get(petId) ?? []
      list.push(alert)
      alertsByPet.set(petId, list)
    }

    for (const alert of medical) {
      push(alert.petId, {
        kind: 'MEDICAL',
        severity: alert.severity,
        label: alert.condition,
      })
    }
    for (const row of temperaments) {
      if (!(RISKY_TEMPERAMENTS as readonly string[]).includes(row.classification)) continue
      push(row.petId, {
        kind: 'TEMPERAMENT',
        severity: row.classification === 'AGGRESSIVE' ? 'CRITICAL' : 'MODERATE',
        label: TEMPERAMENT_LABELS[row.classification] ?? row.classification,
      })
    }

    const stops: RouteStop[] = rows.map((row) => {
      const tutor = tutorById.get(row.tutorId)
      const temperament = temperamentByPet.get(row.petId)
      return {
        ...toRideDto(row, cipher),
        petName: petById.get(row.petId) ?? 'Pet',
        // RN-14 do MOD-TUTOR: o nome social é o exibido quando existe.
        tutorName: tutor?.socialName ?? tutor?.fullName ?? 'Tutor',
        // O telefone é o que resolve "cheguei e ninguém atende" sem voltar vazio.
        tutorPhone: tutor ? safePhone(cipher, tutor.phoneEncrypted, tutor.id) : null,
        alerts: alertsByPet.get(row.petId) ?? [],
        requiresMuzzle: temperament?.requiresMuzzle ?? false,
        requiresTwoHandlers: temperament?.requiresTwoHandlers ?? false,
        waitingForAttendance: row.leg === 'DROPOFF' && row.readyAt === null,
      }
    })

    return { date: day, timezone, stops }
  })
}
