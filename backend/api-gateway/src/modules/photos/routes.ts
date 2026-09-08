import {
  MAX_PHOTOS_PER_UPLOAD,
  UpdatePhotoSchema,
  UploadPhotoMetaSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../pets/auth.js'
import { invalid } from '../pets/errors.js'
import { parseInput } from '../pets/validate.js'
import type { ActorContext } from '../pets/actor.js'
import { deletePhoto, listAlbum, updatePhoto, uploadPhotos, type UploadFile } from './service.js'

/**
 * Rotas do álbum (PRD pets_03 §5).
 *
 * O upload é `multipart/form-data` porque o AC-01 fala em enviar três fotos de uma
 * vez, e é o que o `<input type="file" multiple>` produz sem tradução. Os metadados
 * (legenda, origem) viajam como campos do mesmo multipart.
 */

interface PetParams {
  id: string
}

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export async function registerPhotoRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: PetParams }>(
    '/v1/pets/:id/photos',
    { preHandler: requirePermission('pet:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listAlbum(auth.tenantId, request.params.id)
    },
  )

  /**
   * `pet:upload_photo`: o tosador manda a foto do banho pronto sem poder editar o
   * cadastro (§9). É a mesma lógica de `pet:weigh` na balança.
   */
  app.post<{ Params: PetParams }>(
    '/v1/pets/:id/photos',
    { preHandler: requirePermission('pet:upload_photo', 'Seu perfil não permite enviar fotos') },
    async (request, reply) => {
      const { files, fields } = await readMultipart(request)
      const meta = parseInput(UploadPhotoMetaSchema, fields)
      const photos = await uploadPhotos(actorOf(request), request.params.id, files, meta)
      return reply.status(201).send(photos)
    },
  )

  app.patch<{ Params: PetParams & { photoId: string } }>(
    '/v1/pets/:id/photos/:photoId',
    { preHandler: requirePermission('pet:update') },
    async (request) => {
      const patch = parseInput(UpdatePhotoSchema, request.body)
      return updatePhoto(actorOf(request), request.params.id, request.params.photoId, patch)
    },
  )

  app.delete<{ Params: PetParams & { photoId: string } }>(
    '/v1/pets/:id/photos/:photoId',
    { preHandler: requirePermission('pet:update', 'Seu perfil não permite remover fotos') },
    async (request, reply) => {
      await deletePhoto(actorOf(request), request.params.id, request.params.photoId)
      return reply.status(204).send()
    },
  )
}

interface Multipart {
  files: UploadFile[]
  fields: Record<string, string>
}

/**
 * Lê o multipart inteiro para memória.
 *
 * Streaming direto para o R2 seria mais econômico, mas impediria o AC-02: a validação
 * por magic bytes e a reencodificação que apaga o EXIF precisam do arquivo inteiro
 * antes de qualquer byte sair daqui. O teto de 10 MB por arquivo e de dez arquivos
 * por requisição é o que mantém isso limitado.
 */
async function readMultipart(request: FastifyRequest): Promise<Multipart> {
  if (!request.isMultipart()) {
    throw invalid('Envie as fotos como multipart/form-data', [
      { field: 'files', message: 'Formato de envio inválido' },
    ])
  }

  const files: UploadFile[] = []
  const fields: Record<string, string> = {}

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (files.length >= MAX_PHOTOS_PER_UPLOAD) {
        throw invalid(`Envie no máximo ${MAX_PHOTOS_PER_UPLOAD} fotos por vez`, [
          { field: 'files', message: `Máximo de ${MAX_PHOTOS_PER_UPLOAD} fotos por envio` },
        ])
      }
      files.push({ filename: part.filename, buffer: await part.toBuffer() })
    } else if (typeof part.value === 'string' && part.value !== '') {
      fields[part.fieldname] = part.value
    }
  }

  return { files, fields }
}
