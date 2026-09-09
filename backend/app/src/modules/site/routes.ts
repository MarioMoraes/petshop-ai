import {
  SiteContentPatchSchema,
  SiteLeadInputSchema,
  SiteLeadPatchSchema,
  SiteLeadStatusSchema,
  SitePhotoKindSchema,
  SitePhotoPatchSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission, requireTenantContext } from './auth.js'
import { invalid } from './errors.js'
import { parseInput } from './validate.js'
import type { ActorContext } from './actor.js'
import { getSettings, updateSettings } from './content.js'
import { convertLead, countNewLeads, listLeads, submitLead, updateLead } from './leads.js'
import {
  deletePhoto,
  listPhotos,
  readPublicPhoto,
  updatePhoto,
  uploadPhoto,
} from './photos.js'
import { getPreview, getPublicSite } from './public-payload.js'
import { publishSite, unpublishSite } from './publish.js'

/**
 * As rotas do site (PRD site_tenant_10 §5).
 *
 * **Duas superfícies, e a separação é o desenho do módulo.** A pública é anônima,
 * cacheável e não conhece usuário; ela é registrada fora do escopo autenticado, em
 * `app.ts`, e por isso não há como uma rota administrativa nascer sem gate por
 * esquecimento — ela estaria no arquivo errado.
 *
 * Na superfície pública **o slug vem sempre da querystring**, colocado lá pelo Next a
 * partir do host que ele resolveu. Não vem de um header que o cliente possa forjar:
 * quem decide de que tenant se fala é a borda, não quem chama.
 */

interface IdParams {
  id: string
}

const SlugQuerySchema = z.object({ slug: z.string().min(1).max(50) })

function actorOf(request: FastifyRequest): ActorContext {
  const auth = requireTenantContext(request)
  return {
    tenantId: auth.tenantId,
    actorUserId: auth.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

// ─── Superfície pública ──────────────────────────────────────────────────────

export async function registerPublicSiteRoutes(app: FastifyInstance): Promise<void> {
  /** O payload inteiro da página, montado numa resposta só. */
  app.get('/public/v1/site', async (request) => {
    const { slug } = parseInput(SlugQuerySchema, request.query)
    return getPublicSite(slug)
  })

  /**
   * Os bytes de uma foto da galeria.
   *
   * O host do tenant repassa isto ao visitante com cache longo. A URL é estável e
   * versionada por `updated_at` — ao contrário da URL assinada do álbum do pet, que
   * morre em 15 minutos e não sobreviveria nem ao cache da própria página.
   */
  app.get<{ Params: IdParams }>('/public/v1/site/photos/:id', async (request, reply) => {
    const { slug } = parseInput(SlugQuerySchema, request.query)
    const photo = await readPublicPhoto(slug, request.params.id)
    return reply
      .header('content-type', photo.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(photo.body)
  })

  /**
   * O formulário (MOD-SITE-08).
   *
   * **Sempre 201**, inclusive quando o honeypot vem preenchido: responder com erro
   * ensinaria o bot a contornar (RN-08). O 429 do rate limit é a única resposta
   * diferente, e ela vale para gente também.
   */
  app.post('/public/v1/site/leads', async (request, reply) => {
    const { slug } = parseInput(SlugQuerySchema, request.query)
    const input = parseInput(SiteLeadInputSchema, request.body)

    await submitLead({
      slug,
      input,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    })

    return reply.status(201).send({ received: true })
  })
}

// ─── Superfície administrativa ───────────────────────────────────────────────

export async function registerSiteRoutes(app: FastifyInstance): Promise<void> {
  // ─── Conteúdo e publicação ─────────────────────────────────────────────────

  app.get(
    '/v1/site/settings',
    { preHandler: requirePermission('site:manage') },
    async (request) => getSettings(actorOf(request)),
  )

  app.patch(
    '/v1/site/settings',
    { preHandler: requirePermission('site:manage') },
    async (request) =>
      updateSettings(actorOf(request), parseInput(SiteContentPatchSchema, request.body)),
  )

  app.post(
    '/v1/site/publish',
    { preHandler: requirePermission('site:manage') },
    async (request) => publishSite(actorOf(request)),
  )

  app.post(
    '/v1/site/unpublish',
    { preHandler: requirePermission('site:manage') },
    async (request) => unpublishSite(actorOf(request)),
  )

  /**
   * A pré-visualização monta a página **inclusive despublicada**, e devolve o que
   * falta para publicar: é a tela de Site inteira numa chamada, sem o admin precisar
   * adivinhar por que o botão recusa.
   */
  app.get(
    '/v1/site/preview',
    { preHandler: requirePermission('site:manage') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getPreview(auth.tenantId)
    },
  )

  // ─── Galeria ───────────────────────────────────────────────────────────────

  app.get(
    '/v1/site/photos',
    { preHandler: requirePermission('site:manage') },
    async (request) => ({ items: await listPhotos(actorOf(request)) }),
  )

  app.post(
    '/v1/site/photos',
    { preHandler: requirePermission('site:manage') },
    async (request, reply) => {
      const { file, fields } = await readSinglePart(request)
      const kind = fields.kind ? parseInput(SitePhotoKindSchema, fields.kind) : undefined
      const photo = await uploadPhoto(actorOf(request), {
        body: file.buffer,
        filename: file.filename,
        alt: fields.alt,
        kind,
      })
      return reply.status(201).send(photo)
    },
  )

  app.patch<{ Params: IdParams }>(
    '/v1/site/photos/:id',
    { preHandler: requirePermission('site:manage') },
    async (request) =>
      updatePhoto(
        actorOf(request),
        request.params.id,
        parseInput(SitePhotoPatchSchema, request.body),
      ),
  )

  app.delete<{ Params: IdParams }>(
    '/v1/site/photos/:id',
    { preHandler: requirePermission('site:manage') },
    async (request, reply) => {
      await deletePhoto(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )

  // ─── Fila de leads ─────────────────────────────────────────────────────────

  /**
   * Ver a fila pede `site:read_leads`, que a recepção tem; publicar o site pede
   * `site:manage`, que só o admin tem. São permissões diferentes porque são trabalhos
   * diferentes: quem atende o telefone trabalha o lead, e não mexe na página.
   */
  app.get(
    '/v1/site/leads',
    { preHandler: requirePermission('site:read_leads') },
    async (request) => {
      const query = parseInput(
        z.object({ status: SiteLeadStatusSchema.optional() }),
        request.query,
      )
      return listLeads(actorOf(request), query)
    },
  )

  /**
   * Só o número, para o sino de pendências da topbar.
   *
   * Declarada **antes** de `/v1/site/leads/:id` de propósito. O roteador do Fastify
   * prefere o segmento estático ao parâmetro, então a ordem não decide nada hoje —
   * mas ela documenta a intenção para quem for mexer aqui, e o teste de contrato
   * cobre o caso.
   */
  app.get(
    '/v1/site/leads/count',
    { preHandler: requirePermission('site:read_leads') },
    async (request) => ({ newCount: await countNewLeads(actorOf(request)) }),
  )

  app.patch<{ Params: IdParams }>(
    '/v1/site/leads/:id',
    { preHandler: requirePermission('site:read_leads') },
    async (request) =>
      updateLead(actorOf(request), request.params.id, parseInput(SiteLeadPatchSchema, request.body)),
  )

  /**
   * A conversão exige **também** `tutor:create` (RN-10). Ver leads e criar cliente
   * são coisas distintas na matriz, e o módulo não a contorna: quem cria a ficha é o
   * MOD-TUTOR, e aqui só se anota que aquele lead virou aquele tutor.
   */
  app.post<{ Params: IdParams }>(
    '/v1/site/leads/:id/convert',
    { preHandler: [requirePermission('site:read_leads'), requirePermission('tutor:create')] },
    async (request) => {
      const { tutorId } = parseInput(z.object({ tutorId: z.uuid() }), request.body)
      return convertLead(actorOf(request), request.params.id, tutorId)
    },
  )
}

interface SinglePart {
  file: { filename?: string | undefined; buffer: Buffer }
  fields: Record<string, string>
}

/**
 * Lê o multipart inteiro para memória.
 *
 * Uma foto por requisição, ao contrário do álbum do pet: a galeria é montada devagar,
 * item a item, com legenda e ordem — e o teto de 12 fotos não justifica o envio em
 * lote. O arquivo inteiro precisa estar aqui de qualquer forma, porque a validação
 * por magic bytes e a reencodificação que apaga o EXIF acontecem antes de qualquer
 * byte sair para o R2.
 */
async function readSinglePart(request: FastifyRequest): Promise<SinglePart> {
  if (!request.isMultipart()) {
    throw invalid('Envie a foto como multipart/form-data', [
      { field: 'file', message: 'Formato de envio inválido' },
    ])
  }

  let file: SinglePart['file'] | null = null
  const fields: Record<string, string> = {}

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // O primeiro arquivo é o que vale; os demais precisam ser drenados, senão a
      // requisição fica pendurada esperando o corpo ser consumido.
      const buffer = await part.toBuffer()
      file ??= { filename: part.filename, buffer }
    } else if (typeof part.value === 'string' && part.value !== '') {
      fields[part.fieldname] = part.value
    }
  }

  if (!file) {
    throw invalid('Escolha uma imagem para enviar', [
      { field: 'file', message: 'Nenhum arquivo recebido' },
    ])
  }

  return { file, fields }
}
