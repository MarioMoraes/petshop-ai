import { randomUUID } from 'node:crypto'
import { withTenant, type PetPhoto, type TenantTransaction } from '@petshop/db'
import {
  PET_ROUTING_KEYS,
  PHOTO_QUOTA_BY_PLAN,
  PHOTO_URL_TTL_SECONDS,
  PHOTO_VARIANTS,
  type PetAlbum,
  type Plan,
  type PetPhoto as PetPhotoDto,
  type PhotoQuota,
  type PhotoUrls,
  type UpdatePhotoInput,
  type UploadPhotoMeta,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { consentMissing, invalid, notFound, quotaExceeded, storageFailure } from '../pets/errors.js'
import { publishEvent } from '../../shared/events.js'
import { recordMetric } from '../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../shared/redis.js'
import { getStorage, StorageUnavailableError } from '../../shared/storage.js'

/** `tenants/{tenantId}/pets/{petId}/{photoId}/{variante}.webp` (§4). */
function objectKey(tenantId: string, petId: string, photoId: string, variant: string): string {
  return `tenants/${tenantId}/pets/${petId}/${photoId}/${variant}.webp`
}
import { tenantOptions, type ActorContext } from '../pets/actor.js'
import { assertWritable } from '../pets/guards.js'
import { processPhoto } from './image.js'

/**
 * Álbum de fotos (MOD-PET-04).
 *
 * A ordem das operações é o que o AC-04 pede e não é negociável: **sobe primeiro,
 * grava depois**. Se o R2 falhar, o banco não fica com uma linha apontando para um
 * objeto que não existe — a tela mostraria uma foto quebrada para sempre. O inverso,
 * um objeto no bucket sem linha no banco, é lixo que o `media-purge` recolhe.
 *
 * Nenhuma URL é guardada: `variants` tem chaves de objeto, e a URL sai assinada na
 * leitura com 15 minutos de validade (RN-13). URL guardada em banco nasce vencida.
 */

export interface UploadFile {
  filename: string
  buffer: Buffer
}

interface VariantKeys {
  thumb: string
  medium: string
  full: string
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function listAlbum(tenantId: string, petId: string): Promise<PetAlbum> {
  const { rows, coverPhotoId, quota } = await withTenant(tenantId, async (tx) => {
    const pet = await tx.pet.findFirst({
      where: { id: petId, deletedAt: null },
      select: { id: true, coverPhotoId: true },
    })
    if (!pet) throw notFound()

    const [photos, used, tenant] = await Promise.all([
      tx.petPhoto.findMany({
        where: { petId, deletedAt: null },
        orderBy: [{ takenAt: 'desc' }, { createdAt: 'desc' }],
      }),
      tx.petPhoto.count({ where: { deletedAt: null } }),
      tx.tenant.findFirst({ select: { plan: true } }),
    ])

    return {
      rows: photos,
      coverPhotoId: pet.coverPhotoId,
      quota: { used, limit: quotaOf(tenant?.plan) },
    }
  })

  const photos = await Promise.all(rows.map((row) => toPhotoDto(row, coverPhotoId)))
  return { photos, quota }
}

/**
 * URL da capa de cada pet, para a listagem e o detalhe.
 *
 * RN-16 é o motivo de isso não ser um extra: cinco "Mel" no mesmo tenant é normal, e
 * a foto é o que desambigua no balcão. Assinar é cálculo local — não há ida ao R2 —,
 * então assinar vinte capas de uma listagem custa microssegundos, não uma rodada de
 * rede por linha.
 */
export async function coverUrlsFor(
  tx: TenantTransaction,
  pets: { id: string; coverPhotoId: string | null }[],
): Promise<Map<string, string>> {
  const wanted = pets.filter((pet) => pet.coverPhotoId !== null)
  if (wanted.length === 0) return new Map()

  const photos = await tx.petPhoto.findMany({
    where: { id: { in: wanted.map((pet) => pet.coverPhotoId as string) }, deletedAt: null },
    select: { id: true, variants: true },
  })
  const byId = new Map(photos.map((photo) => [photo.id, photo]))

  const result = new Map<string, string>()
  for (const pet of wanted) {
    const photo = byId.get(pet.coverPhotoId as string)
    if (!photo) continue
    const url = await signVariant(keysOf(photo.variants), 'medium')
    if (url) result.set(pet.id, url)
  }
  return result
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function uploadPhotos(
  actor: ActorContext,
  petId: string,
  files: UploadFile[],
  meta: UploadPhotoMeta,
): Promise<PetPhotoDto[]> {
  if (files.length === 0) {
    throw invalid('Nenhum arquivo recebido', [{ field: 'files', message: 'Envie ao menos uma foto' }])
  }

  const startedAt = Date.now()

  // 1. O pet existe e aceita escrita, e o plano comporta as fotos. As duas checagens
  //    vêm antes de processar: recusar depois de o atendente esperar o upload de três
  //    arquivos de 10 MB é desperdício do tempo dele e da nossa banda.
  const { coverPhotoId } = await withTenant(actor.tenantId, async (tx) => {
    const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
    if (!pet) throw notFound()
    assertWritable(pet)
    await assertQuota(tx, files.length)
    return { coverPhotoId: pet.coverPhotoId }
  })

  // 2. Processa e sobe tudo, fora de qualquer transação: reencodar imagem e falar com
  //    o R2 leva segundos, e uma transação aberta esse tempo todo seguraria conexão
  //    do pool à toa.
  const uploaded: { photoId: string; keys: VariantKeys; mimeType: string; bytes: number }[] = []
  try {
    for (const file of files) {
      const processed = await processPhoto(file.buffer, file.filename)
      const photoId = randomUUID()
      const keys = {} as VariantKeys

      for (const variant of processed.variants) {
        const key = objectKey(actor.tenantId, petId, photoId, variant.variant)
        await getStorage().put(key, variant.body, 'image/webp')
        keys[variant.variant] = key
      }

      uploaded.push({
        photoId,
        keys,
        mimeType: processed.mimeType,
        bytes: processed.originalBytes,
      })
    }
  } catch (error) {
    // O que já subiu vira lixo: remove na hora, e o que escapar fica para o purge.
    await getStorage().remove(uploaded.flatMap((item) => Object.values(item.keys)))
    if (error instanceof StorageUnavailableError) {
      recordMetric({
        metric: 'pet_photo_upload_failed_total',
        tenantId: actor.tenantId,
        value: 1,
        unit: 'count',
      })
      throw storageFailure()
    }
    throw error
  }

  // 3. Só agora o banco. A cota é conferida de novo dentro da transação: dois
  //    atendentes subindo ao mesmo tempo passariam os dois pela checagem do passo 1.
  const rows = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertQuota(tx, uploaded.length)

      const created: PetPhoto[] = []
      for (const item of uploaded) {
        created.push(
          await tx.petPhoto.create({
            data: {
              id: item.photoId,
              tenantId: actor.tenantId,
              petId,
              variants: item.keys,
              caption: meta.caption ?? null,
              takenAt: meta.takenAt ? new Date(meta.takenAt) : new Date(),
              source: meta.source,
              attendanceId: meta.attendanceId ?? null,
              attendancePhase: meta.attendancePhase ?? null,
              sizeBytes: item.bytes,
              mimeType: item.mimeType,
              uploadedBy: actor.actorUserId ?? null,
            },
          }),
        )
      }

      // A primeira foto do pet vira a capa sozinha: pedir para o atendente escolher
      // capa quando só existe uma seria burocracia sem escolha.
      if (!coverPhotoId && created[0]) {
        await tx.pet.update({ where: { id: petId }, data: { coverPhotoId: created[0].id } })
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.photo_uploaded',
        entity: 'pet',
        entityId: petId,
        after: { photoIds: created.map((photo) => photo.id), source: meta.source },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return created
    },
    tenantOptions(actor),
  )

  const effectiveCover = coverPhotoId ?? rows[0]?.id ?? null
  await invalidatePetCaches(actor.tenantId, petId)

  for (const row of rows) {
    await publishEvent(PET_ROUTING_KEYS.petFotoAdicionada, {
      tenantId: actor.tenantId,
      petId,
      photoId: row.id,
      source: row.source,
      attendanceId: row.attendanceId,
    })
  }

  recordMetric({
    metric: 'pet_photo_upload_duration',
    tenantId: actor.tenantId,
    value: Date.now() - startedAt,
    unit: 'ms',
  })
  recordMetric({
    metric: 'pet_storage_bytes_per_tenant',
    tenantId: actor.tenantId,
    value: rows.reduce((total, row) => total + row.sizeBytes, 0),
    unit: 'bytes',
  })

  return Promise.all(rows.map((row) => toPhotoDto(row, effectiveCover)))
}

// ─── Edição ──────────────────────────────────────────────────────────────────

export async function updatePhoto(
  actor: ActorContext,
  petId: string,
  photoId: string,
  patch: UpdatePhotoInput,
): Promise<PetPhotoDto> {
  const { row, coverPhotoId } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!pet) throw notFound()

      const before = await tx.petPhoto.findFirst({ where: { id: photoId, petId, deletedAt: null } })
      if (!before) throw notFound('Foto não encontrada')

      // RN-14: a checagem é no momento do uso, não no do upload. O tutor pode ter
      // revogado o consentimento depois que a foto entrou no álbum.
      if (patch.marketingUse === true) await assertImageConsent(tx, petId)

      const updated = await tx.petPhoto.update({
        where: { id: photoId },
        data: {
          ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
          ...(patch.marketingUse !== undefined ? { marketingUse: patch.marketingUse } : {}),
        },
      })

      let cover = pet.coverPhotoId
      if (patch.isCover !== undefined) {
        cover = patch.isCover ? photoId : pet.coverPhotoId === photoId ? null : pet.coverPhotoId
        await tx.pet.update({ where: { id: petId }, data: { coverPhotoId: cover } })
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.photo_updated',
        entity: 'pet',
        entityId: petId,
        before: { marketingUse: before.marketingUse, caption: before.caption },
        after: { photoId, ...patch },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { row: updated, coverPhotoId: cover }
    },
    tenantOptions(actor),
  )

  await invalidatePetCaches(actor.tenantId, petId)
  return toPhotoDto(row, coverPhotoId)
}

// ─── Exclusão ────────────────────────────────────────────────────────────────

/**
 * Soft delete na tela, remoção de verdade no bucket.
 *
 * §9 é explícito: marcar `deleted_at` não cumpre o direito ao esquecimento. O objeto
 * sai agora; o que falhar fica para o `media-purge` reconciliar — daí a remoção ser
 * best-effort e a linha guardar as chaves mesmo depois de apagada.
 */
export async function deletePhoto(actor: ActorContext, petId: string, photoId: string): Promise<void> {
  const keys = await withTenant(
    actor.tenantId,
    async (tx) => {
      const pet = await tx.pet.findFirst({ where: { id: petId, deletedAt: null } })
      if (!pet) throw notFound()

      const photo = await tx.petPhoto.findFirst({ where: { id: photoId, petId, deletedAt: null } })
      if (!photo) throw notFound('Foto não encontrada')

      await tx.petPhoto.update({ where: { id: photoId }, data: { deletedAt: new Date() } })

      // A capa apagada não pode continuar apontada: a listagem mostraria um buraco.
      if (pet.coverPhotoId === photoId) {
        const next = await tx.petPhoto.findFirst({
          where: { petId, deletedAt: null, id: { not: photoId } },
          orderBy: [{ takenAt: 'desc' }, { createdAt: 'desc' }],
          select: { id: true },
        })
        await tx.pet.update({ where: { id: petId }, data: { coverPhotoId: next?.id ?? null } })
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'pet.photo_deleted',
        entity: 'pet',
        entityId: petId,
        before: { photoId, caption: photo.caption },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return Object.values(keysOf(photo.variants))
    },
    tenantOptions(actor),
  )

  await invalidatePetCaches(actor.tenantId, petId, photoId)
  await getStorage().remove(keys)
}

// ─── Regras compartilhadas ───────────────────────────────────────────────────

function quotaOf(plan: Plan | undefined): number | null {
  if (!plan) return null
  return PHOTO_QUOTA_BY_PLAN[plan]
}

/** AC-03: 402 com o CTA de upgrade, não um 403 genérico. */
async function assertQuota(tx: TenantTransaction, incoming: number): Promise<void> {
  const tenant = await tx.tenant.findFirst({ select: { plan: true } })
  const limit = quotaOf(tenant?.plan)
  if (limit === null) return

  const used = await tx.petPhoto.count({ where: { deletedAt: null } })
  if (used + incoming <= limit) return

  throw quotaExceeded('Limite de fotos do plano atingido', {
    quota: { used, limit } satisfies PhotoQuota,
    upgradePath: '/configuracoes',
  })
}

/**
 * RN-14 / AC-05 — consentimento de uso de imagem.
 *
 * A conferência é sobre o **responsável principal**: é ele quem responde pelo pet,
 * pela mesma razão que RN-05 manda o débito para a conta dele. Um tenant que queira a
 * regra mais estrita — todos os responsáveis ativos — muda o `findFirst` por um
 * `findMany` e exige que todos tenham concedido.
 */
async function assertImageConsent(tx: TenantTransaction, petId: string): Promise<void> {
  const primary = await tx.petTutor.findFirst({
    where: { petId, role: 'PRIMARY', unlinkedAt: null },
    select: { tutorId: true },
  })
  if (!primary) {
    throw consentMissing('Este pet não tem responsável principal para autorizar o uso da imagem')
  }

  // `IMAGE_USE` é **canal** de consentimento desde o MOD-TUTOR (tutores_02 §4), não
  // finalidade — a mesma linha que a aba de consentimento do tutor grava. A tabela é
  // append-only, então o estado corrente é a última transição do canal.
  const latest = await tx.tutorConsent.findFirst({
    where: { tutorId: primary.tutorId, channel: 'IMAGE_USE' },
    orderBy: { createdAt: 'desc' },
  })

  if (!latest?.granted) {
    throw consentMissing('O tutor não autorizou o uso da imagem do pet', {
      tutorId: primary.tutorId,
      channel: 'IMAGE_USE',
    })
  }
}

/** `variants` é JSONB; o Prisma devolve `JsonValue` e o formato é nosso. */
function keysOf(variants: unknown): VariantKeys {
  const value = (variants ?? {}) as Partial<VariantKeys>
  return {
    thumb: value.thumb ?? '',
    medium: value.medium ?? '',
    full: value.full ?? '',
  }
}

/**
 * URLs assinadas das três variantes, cacheadas por 840s — abaixo dos 900s da
 * assinatura, para nunca servir de cache uma URL prestes a vencer (§10).
 */
async function signedUrls(photoId: string, keys: VariantKeys): Promise<PhotoUrls> {
  const cacheKey = CACHE_KEYS.photoUrls(photoId)
  const cached = await cacheGet<PhotoUrls>(cacheKey)
  if (cached) return cached

  const urls = {} as PhotoUrls
  for (const variant of PHOTO_VARIANTS) {
    urls[variant] = (await signVariant(keys, variant)) ?? ''
  }

  await cacheSet(cacheKey, urls, CACHE_TTL_SECONDS.photoUrls)
  return urls
}

/**
 * Uma variante assinada. Falha de assinatura devolve `null` em vez de estourar: o
 * álbum com uma foto sem endereço ainda é útil; o álbum que não abre, não.
 */
async function signVariant(keys: VariantKeys, variant: keyof VariantKeys): Promise<string | null> {
  const key = keys[variant]
  if (!key) return null
  try {
    return await getStorage().signedUrl(key, PHOTO_URL_TTL_SECONDS)
  } catch {
    return null
  }
}

async function toPhotoDto(row: PetPhoto, coverPhotoId: string | null): Promise<PetPhotoDto> {
  return {
    id: row.id,
    petId: row.petId,
    urls: await signedUrls(row.id, keysOf(row.variants)),
    caption: row.caption,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    attendanceId: row.attendanceId,
    attendancePhase: row.attendancePhase,
    marketingUse: row.marketingUse,
    isCover: row.id === coverPhotoId,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    createdAt: row.createdAt.toISOString(),
  }
}

async function invalidatePetCaches(tenantId: string, petId: string, photoId?: string): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.pet(tenantId, petId),
    ...(photoId ? [CACHE_KEYS.photoUrls(photoId)] : []),
  )
}
