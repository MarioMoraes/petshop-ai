import { withTenant, type TenantTransaction } from '@petshop/db'
import type { AppointmentResponse } from '@petshop/shared-types'
import { notFound } from './errors.js'
import type { ActorContext } from '../schedule-catalog/actor.js'
import { decryptOptional, openCipher } from './crypto.js'

/**
 * Leitura de agendamentos.
 *
 * As respostas trazem `petName` e `professionalName` porque a tela da recepção é uma
 * lista de nomes, não de UUIDs — e resolver isso no cliente exigiria uma chamada por
 * linha. `tutorId` vai sem nome de propósito: quem precisa do tutor abre a ficha
 * dele, e trazer PII em toda listagem de agenda é exposição sem uso.
 */

type Row = Awaited<ReturnType<typeof findRows>>[number]

async function findRows(tx: TenantTransaction, where: object) {
  return tx.appointment.findMany({
    where,
    include: {
      items: true,
      pet: { select: { name: true } },
      professional: { select: { displayName: true } },
    },
    orderBy: { startsAt: 'asc' },
    take: 200,
  })
}

function toResponse(row: Row, notes: string | null): AppointmentResponse {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    petId: row.petId,
    petName: row.pet.name,
    tutorId: row.tutorId,
    professionalId: row.professionalId,
    professionalName: row.professional.displayName,
    items: row.items.map((item) => ({
      serviceId: item.serviceId,
      label: item.label,
      priceCents: Number(item.priceCents),
      durationMin: item.durationMin,
      addedAtCheckout: item.addedAtCheckout,
    })),
    totalCents: Number(row.totalCents),
    checkinAt: row.checkinAt?.toISOString() ?? null,
    checkoutAt: row.checkoutAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledLate: row.cancelledLate,
    notes,
    createdAt: row.createdAt.toISOString(),
  }
}

export interface ListFilters {
  from?: string | undefined
  to?: string | undefined
  professionalId?: string | undefined
  petId?: string | undefined
  tutorId?: string | undefined
  status?: string | undefined
}

export async function listAppointments(
  actor: ActorContext,
  filters: ListFilters,
): Promise<AppointmentResponse[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await findRows(tx, {
      ...(filters.from ? { endsAt: { gt: new Date(filters.from) } } : {}),
      ...(filters.to ? { startsAt: { lt: new Date(filters.to) } } : {}),
      ...(filters.professionalId ? { professionalId: filters.professionalId } : {}),
      ...(filters.petId ? { petId: filters.petId } : {}),
      ...(filters.tutorId ? { tutorId: filters.tutorId } : {}),
      ...(filters.status ? { status: filters.status as 'CONFIRMED' } : {}),
    })

    // A observação **não** é decifrada na listagem: ela é campo livre com risco de
    // dado pessoal, e a lista do dia não precisa dela. Quem quer ler abre o detalhe.
    return rows.map((row) => toResponse(row, null))
  })
}

export async function getAppointment(
  actor: ActorContext,
  appointmentId: string,
): Promise<AppointmentResponse> {
  return withTenant(actor.tenantId, async (tx) => {
    const [row] = await findRows(tx, { id: appointmentId })
    if (!row) throw notFound('Agendamento não encontrado')

    const cipher = row.notesEncrypted ? await openCipher(tx, actor.tenantId) : null
    const notes = cipher ? decryptOptional(cipher, row.notesEncrypted) : null

    return toResponse(row, notes)
  })
}
