import { withTenant } from '@petshop/db'
import sharp from 'sharp'
import {
  SITE_PHOTO_LIMIT,
  SITE_PHOTO_MAX_BYTES,
  sniffImageMime,
  type SitePhoto,
  type SitePhotoKind,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import {
  galleryFull,
  invalid,
  photoNotFound,
  storageUnavailable,
} from './errors.js'
import { refreshSite } from './revalidate.js'
import { getStorage, objectKey, StorageUnavailableError } from '../../shared/storage.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { photoUrl } from './photo-url.js'
import { resolveTenant } from './resolve.js'

/**
 * A galeria do estabelecimento (MOD-SITE-04).
 *
 * **A origem não é o álbum do pet.** Reaproveitar `pet_photos` na página pública
 * transformaria consentimento de guarda em consentimento de publicação, que são
 * coisas diferentes (AC-03). Aqui é upload novo e deliberado, e a tela avisa sobre a
 * autorização do tutor quando a foto for de um pet de cliente.
 *
 * Uma variante só, ao contrário do álbum do pet: a página mostra a foto num tamanho
 * só, e três variantes seriam três objetos para servir a mesma tag `<img>`. O EXIF
 * some pelo mesmo mecanismo — reencodar para WebP não copia metadado, e não há campo
 * a esquecer.
 */

const MAX_WIDTH_PX = 1600

interface PhotoRow {
  id: string
  alt: string | null
  kind: SitePhotoKind
  position: number
  updatedAt: Date
}

function toDto(slug: string, row: PhotoRow): SitePhoto {
  return {
    id: row.id,
    url: photoUrl(slug, row.id, row.updatedAt),
    alt: row.alt,
    kind: row.kind,
    position: row.position,
  }
}

async function slugOf(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true },
    })
    return row.slug
  })
}

export async function listPhotos(actor: ActorContext): Promise<SitePhoto[]> {
  const slug = await slugOf(actor.tenantId)
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.sitePhoto.findMany({
      orderBy: [{ kind: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, alt: true, kind: true, position: true, updatedAt: true },
    })
    return rows.map((row) => toDto(slug, row))
  })
}

export interface UploadInput {
  body: Buffer
  filename?: string | undefined
  alt?: string | null | undefined
  kind?: SitePhotoKind | undefined
}

export async function uploadPhoto(actor: ActorContext, input: UploadInput): Promise<SitePhoto> {
  if (input.body.length === 0) {
    throw invalid('Arquivo vazio. Envie JPG, PNG ou WEBP.')
  }
  if (input.body.length > SITE_PHOTO_MAX_BYTES) {
    throw invalid('Imagem acima de 8 MB. Reduza o arquivo e tente de novo.')
  }
  // O que decide é o magic byte, não a extensão nem o content-type: os dois são
  // declaração do cliente, e um `.pdf` renomeado morre aqui.
  if (!sniffImageMime(input.body)) {
    throw invalid('Formato inválido. Envie JPG, PNG ou WEBP.')
  }

  const slug = await slugOf(actor.tenantId)

  const processed = await sharp(input.body, { failOn: 'error' })
    .rotate()
    .resize({ width: MAX_WIDTH_PX, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw invalid(
        `Não conseguimos processar ${input.filename ?? 'a imagem'}. O arquivo parece corrompido.`,
      )
    })

  const row = await withTenant(
    actor.tenantId,
    async (tx) => {
      const count = await tx.sitePhoto.count()
      if (count >= SITE_PHOTO_LIMIT) {
        throw galleryFull(
          `A galeria comporta ${SITE_PHOTO_LIMIT} fotos. Remova uma antes de subir outra.`,
        )
      }

      const last = await tx.sitePhoto.findFirst({
        orderBy: { position: 'desc' },
        select: { position: true },
      })

      // A primeira foto é a capa, e a regra mora **aqui**, não na tela: a capa é o que
      // abre a página e o que vai como imagem no WhatsApp de quem compartilha o link.
      // Deixá-la no cliente faria uma galeria montada por qualquer outro caminho
      // nascer sem foto principal, e o admin teria de descobrir sozinho como escolher
      // uma.
      const hasHero = (await tx.sitePhoto.count({ where: { kind: 'HERO' } })) > 0
      const kind = input.kind ?? (hasHero ? 'GALLERY' : 'HERO')

      const created = await tx.sitePhoto.create({
        data: {
          tenantId: actor.tenantId,
          storageKey: '',
          alt: input.alt ?? null,
          kind,
          position: (last?.position ?? -1) + 1,
          widthPx: processed.info.width,
          heightPx: processed.info.height,
          contentType: 'image/webp',
          sizeBytes: processed.data.length,
          createdBy: actor.actorUserId ?? null,
        },
        select: { id: true, alt: true, kind: true, position: true, updatedAt: true },
      })

      // A chave deriva do id, então só existe depois do insert. O `put` acontece
      // **dentro** da transação de propósito: falhar depois de gravar a linha
      // deixaria uma foto que a página tenta carregar e o bucket não tem.
      const key = objectKey(actor.tenantId, created.id)
      try {
        await getStorage().put(key, processed.data, 'image/webp')
      } catch (error) {
        if (error instanceof StorageUnavailableError) throw storageUnavailable()
        throw error
      }

      const saved = await tx.sitePhoto.update({
        where: { id: created.id },
        data: { storageKey: key },
        select: { id: true, alt: true, kind: true, position: true, updatedAt: true },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'site_photo.uploaded',
        entity: 'site_photo',
        entityId: created.id,
        after: { kind: saved.kind, bytes: processed.data.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return saved
    },
    tenantOptions(actor),
  )

  await refreshSite(actor.tenantId)
  return toDto(slug, row)
}

export async function updatePhoto(
  actor: ActorContext,
  photoId: string,
  input: { alt?: string | null | undefined; kind?: SitePhotoKind | undefined; position?: number | undefined },
): Promise<SitePhoto> {
  const slug = await slugOf(actor.tenantId)

  const row = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.sitePhoto.findUnique({
        where: { id: photoId },
        select: { id: true },
      })
      if (!before) throw photoNotFound()

      return tx.sitePhoto.update({
        where: { id: photoId },
        data: {
          ...(input.alt !== undefined ? { alt: input.alt ?? null } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
        select: { id: true, alt: true, kind: true, position: true, updatedAt: true },
      })
    },
    tenantOptions(actor),
  )

  await refreshSite(actor.tenantId)
  return toDto(slug, row)
}

export async function deletePhoto(actor: ActorContext, photoId: string): Promise<void> {
  const key = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.sitePhoto.findUnique({
        where: { id: photoId },
        select: { id: true, storageKey: true },
      })
      if (!row) throw photoNotFound()

      await tx.sitePhoto.delete({ where: { id: photoId } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'site_photo.deleted',
        entity: 'site_photo',
        entityId: photoId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return row.storageKey
    },
    tenantOptions(actor),
  )

  // Fora da transação: o objeto some depois que a linha sumiu, e a falha do bucket
  // não desfaz a remoção que o admin pediu.
  await getStorage().remove(key ? [key] : [])
  await refreshSite(actor.tenantId)
}

/**
 * Os bytes de uma foto, para o host do tenant repassar ao visitante.
 *
 * Anônimo por definição — a foto está numa página pública. O que o `slug` faz aqui é
 * garantir que a foto pedida é **daquele** tenant: sem isso, o id de uma foto de um
 * petshop serviria no host de outro, e a página de um viraria vitrine do vizinho.
 */
export async function readPublicPhoto(
  slug: string,
  photoId: string,
): Promise<{ body: Buffer; contentType: string }> {
  const tenant = await resolveTenant(slug)

  const row = await withTenant(tenant.id, (tx) =>
    tx.sitePhoto.findUnique({
      where: { id: photoId },
      select: { storageKey: true, contentType: true },
    }),
  )
  if (!row?.storageKey) throw photoNotFound()

  const object = await getStorage().read(row.storageKey)
  if (!object) throw photoNotFound()

  return { body: object.body, contentType: object.contentType || row.contentType }
}
