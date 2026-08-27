import {
  TAXI_LEG_LABELS,
  TAXI_RIDE_STATUS_LABELS,
  type TaxiCancelReason,
  type TaxiFailureReason,
  type TaxiLeg,
  type TaxiPriceSource,
  type TaxiRideStatus,
} from '@petshop/shared-types'
import { decryptOptional, type TaxiCipher } from './crypto.js'

/**
 * A corrida como a API a devolve.
 *
 * O endereço sai **decifrado** — é para isso que ele existe. Quem chega até aqui já
 * passou pelo corte de permissão do §9, e um motorista sem a rua não entrega nada.
 */

export interface TaxiRideRow {
  id: string
  appointmentId: string
  petId: string
  tutorId: string
  leg: TaxiLeg
  status: TaxiRideStatus
  windowStartsAt: Date
  windowEndsAt: Date
  driverId: string | null
  vehicleId: string | null
  addressId: string | null
  zipCode: string
  streetEncrypted: string
  numberEncrypted: string
  complementEncrypted: string | null
  accessNotesEncrypted: string | null
  district: string
  city: string
  state: string
  zoneId: string | null
  priceCents: bigint
  priceSource: TaxiPriceSource
  appointmentItemId: string | null
  readyAt: Date | null
  assignedAt: Date | null
  enRouteAt: Date | null
  arrivedAt: Date | null
  onboardAt: Date | null
  deliveredAt: Date | null
  failureReason: TaxiFailureReason | null
  cancelReason: TaxiCancelReason | null
  cancelledAt: Date | null
  notesEncrypted: string | null
  createdAt: Date
}

export interface TaxiRideDto {
  id: string
  appointmentId: string
  petId: string
  tutorId: string
  leg: TaxiLeg
  legLabel: string
  status: TaxiRideStatus
  statusLabel: string
  windowStartsAt: string
  windowEndsAt: string
  driverId: string | null
  vehicleId: string | null
  address: {
    zipCode: string
    street: string
    number: string
    complement: string | null
    district: string
    city: string
    state: string
    accessNotes: string | null
  }
  zoneId: string | null
  priceCents: number
  priceSource: TaxiPriceSource
  /** RN-10: nulo em `DROPOFF` significa pet ainda no atendimento. */
  readyAt: string | null
  timestamps: {
    assignedAt: string | null
    enRouteAt: string | null
    arrivedAt: string | null
    onboardAt: string | null
    deliveredAt: string | null
    cancelledAt: string | null
  }
  failureReason: TaxiFailureReason | null
  cancelReason: TaxiCancelReason | null
  notes: string | null
  createdAt: string
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

export function toRideDto(row: TaxiRideRow, cipher: TaxiCipher): TaxiRideDto {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    petId: row.petId,
    tutorId: row.tutorId,
    leg: row.leg,
    legLabel: TAXI_LEG_LABELS[row.leg],
    status: row.status,
    statusLabel: TAXI_RIDE_STATUS_LABELS[row.status],
    windowStartsAt: row.windowStartsAt.toISOString(),
    windowEndsAt: row.windowEndsAt.toISOString(),
    driverId: row.driverId,
    vehicleId: row.vehicleId,
    address: {
      zipCode: row.zipCode,
      street: cipher.decrypt(row.streetEncrypted),
      number: cipher.decrypt(row.numberEncrypted),
      complement: decryptOptional(cipher, row.complementEncrypted),
      district: row.district,
      city: row.city,
      state: row.state,
      accessNotes: decryptOptional(cipher, row.accessNotesEncrypted),
    },
    zoneId: row.zoneId,
    priceCents: Number(row.priceCents),
    priceSource: row.priceSource,
    readyAt: iso(row.readyAt),
    timestamps: {
      assignedAt: iso(row.assignedAt),
      enRouteAt: iso(row.enRouteAt),
      arrivedAt: iso(row.arrivedAt),
      onboardAt: iso(row.onboardAt),
      deliveredAt: iso(row.deliveredAt),
      cancelledAt: iso(row.cancelledAt),
    },
    failureReason: row.failureReason,
    cancelReason: row.cancelReason,
    notes: decryptOptional(cipher, row.notesEncrypted),
    createdAt: row.createdAt.toISOString(),
  }
}
