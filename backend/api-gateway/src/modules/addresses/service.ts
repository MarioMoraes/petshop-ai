import { withTenant, type TenantTransaction } from '@petshop/db'
import type { AddressInput, AddressResponse, UpdateAddressInput } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { notFound } from '../tutors/errors.js'
import { invalidateTutor } from '../../shared/redis.js'
import { openCipher, type TutorCipher } from '../tutors/crypto.js'
import { toAddressResponse } from '../tutors/mapper.js'
import { assertWritable, type ActorContext } from '../tutors/service.js'

/**
 * Endereços do tutor (MOD-TUTOR-03).
 *
 * Logradouro, número e complemento ficam cifrados — endereço residencial é o dado
 * cuja fuga tem consequência física para o titular. Bairro, cidade e UF ficam em
 * claro: sozinhos não localizam ninguém e são o que a roteirização do Taxi Dog e os
 * relatórios agregam.
 */

interface CreateAddressParams {
  tenantId: string
  tutorId: string
  input: AddressInput
}

/**
 * Grava dentro de uma transação já aberta — é o que permite o endereço entrar no
 * mesmo commit do cadastro do tutor.
 */
export async function createAddressIn(
  tx: TenantTransaction,
  cipher: TutorCipher,
  params: CreateAddressParams,
): Promise<AddressResponse> {
  const { tenantId, tutorId, input } = params

  // RN-15: um endereço principal por tutor. O índice único parcial garante; aqui a
  // gente rebaixa o anterior na **mesma** transação, para não colidir com ele.
  if (input.isPrimary) {
    await tx.tutorAddress.updateMany({
      where: { tutorId, isPrimary: true },
      data: { isPrimary: false },
    })
  }

  const created = await tx.tutorAddress.create({
    data: {
      tenantId,
      tutorId,
      label: input.label,
      zipCode: input.zipCode,
      streetEncrypted: cipher.encrypt(input.street),
      numberEncrypted: cipher.encrypt(input.number),
      complementEncrypted: input.complement ? cipher.encrypt(input.complement) : null,
      district: input.district,
      city: input.city,
      state: input.state,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      accessNotes: input.accessNotes ?? null,
      isPrimary: input.isPrimary,
    },
  })

  return toAddressResponse(created, cipher)
}

export async function listAddresses(
  tenantId: string,
  tutorId: string,
): Promise<AddressResponse[]> {
  return withTenant(tenantId, async (tx) => {
    const tutor = await tx.tutor.findFirst({
      where: { id: tutorId, deletedAt: null },
      select: { id: true },
    })
    if (!tutor) throw notFound()

    const [rows, cipher] = await Promise.all([
      tx.tutorAddress.findMany({
        where: { tutorId },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
      openCipher(tx, tenantId),
    ])
    return rows.map((row) => toAddressResponse(row, cipher))
  })
}

export async function addAddress(
  actor: ActorContext,
  tutorId: string,
  input: AddressInput,
): Promise<AddressResponse> {
  const address = await withTenant(
    actor.tenantId,
    async (tx) => {
      const tutor = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!tutor) throw notFound()
      assertWritable(tutor)

      const cipher = await openCipher(tx, actor.tenantId)
      const isFirst = (await tx.tutorAddress.count({ where: { tutorId } })) === 0

      const created = await createAddressIn(tx, cipher, {
        tenantId: actor.tenantId,
        tutorId,
        input: { ...input, isPrimary: input.isPrimary || isFirst },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.address_added',
        entity: 'tutor_address',
        entityId: created.id,
        after: { tutorId, city: created.city, state: created.state },
        ipAddress: actor.ipAddress ?? null,
      })

      return created
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)
  return address
}

export async function updateAddress(
  actor: ActorContext,
  tutorId: string,
  addressId: string,
  patch: UpdateAddressInput,
): Promise<AddressResponse> {
  const address = await withTenant(
    actor.tenantId,
    async (tx) => {
      const existing = await tx.tutorAddress.findFirst({ where: { id: addressId, tutorId } })
      if (!existing) throw notFound('Endereço não encontrado')

      const tutor = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!tutor) throw notFound()
      assertWritable(tutor)

      const cipher = await openCipher(tx, actor.tenantId)

      if (patch.isPrimary) {
        await tx.tutorAddress.updateMany({
          where: { tutorId, isPrimary: true, NOT: { id: addressId } },
          data: { isPrimary: false },
        })
      }

      const updated = await tx.tutorAddress.update({
        where: { id: addressId },
        data: {
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.zipCode !== undefined ? { zipCode: patch.zipCode } : {}),
          ...(patch.street !== undefined ? { streetEncrypted: cipher.encrypt(patch.street) } : {}),
          ...(patch.number !== undefined ? { numberEncrypted: cipher.encrypt(patch.number) } : {}),
          ...(patch.complement !== undefined
            ? {
                complementEncrypted: patch.complement ? cipher.encrypt(patch.complement) : null,
              }
            : {}),
          ...(patch.district !== undefined ? { district: patch.district } : {}),
          ...(patch.city !== undefined ? { city: patch.city } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.latitude !== undefined ? { latitude: patch.latitude } : {}),
          ...(patch.longitude !== undefined ? { longitude: patch.longitude } : {}),
          ...(patch.accessNotes !== undefined ? { accessNotes: patch.accessNotes } : {}),
          ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary } : {}),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.address_updated',
        entity: 'tutor_address',
        entityId: addressId,
        before: { city: existing.city, state: existing.state, isPrimary: existing.isPrimary },
        after: { city: updated.city, state: updated.state, isPrimary: updated.isPrimary },
        ipAddress: actor.ipAddress ?? null,
      })

      return toAddressResponse(updated, cipher)
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)
  return address
}
