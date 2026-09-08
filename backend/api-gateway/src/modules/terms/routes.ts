import {
  AcceptTermSchema,
  PublishTermVersionSchema,
  TermKindSchema,
  type TermKind,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../tutors/auth.js'
import { invalid } from '../tutors/errors.js'
import { parseInput } from '../tutors/validate.js'
import type { ActorContext } from '../tutors/service.js'
import { acceptTerm, getTutorDocument, listTutorDocuments } from './acceptance.js'
import { currentTermForDisplay, listTermVersions, publishTermVersion } from './service.js'

/**
 * Rotas dos termos (PRD documentos_pdf_11 §5).
 *
 * **Nenhuma permissão nova**, como no resto do MOD-DOC: a permissão de um documento é a
 * permissão do assunto dele. Publicar termo é configurar o estabelecimento
 * (`tenant:configure`), ler o texto vigente é o mesmo `tenant:read_settings` que abre as
 * Configurações — e a recepção o tem, porque é ela que apresenta o termo no balcão.
 * Registrar o aceite é escrita na ficha do tutor (`tutor:update`).
 *
 * **Não há PATCH nem DELETE de versão.** A ausência é a regra: versão publicada é
 * imutável, e republicar o mesmo número devolve 409.
 */

interface TutorParams {
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

function parseKind(value: string): TermKind {
  const parsed = TermKindSchema.safeParse(value)
  if (!parsed.success) throw invalid(`Tipo de termo desconhecido: ${value}`)
  return parsed.data
}

export async function registerTermRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/terms',
    { preHandler: requirePermission('tenant:read_settings') },
    async (request) => {
      const auth = requireTenantContext(request)
      return listTermVersions(auth.tenantId)
    },
  )

  /** O texto vigente de um tipo — é o que a tela apresenta antes de colher o aceite. */
  app.get<{ Params: { kind: string } }>(
    '/v1/terms/current/:kind',
    { preHandler: requirePermission('tenant:read_settings') },
    async (request) => {
      const auth = requireTenantContext(request)
      return currentTermForDisplay(auth.tenantId, parseKind(request.params.kind))
    },
  )

  app.post(
    '/v1/terms',
    {
      preHandler: requirePermission(
        'tenant:configure',
        'Publicar termo é do administrador do estabelecimento',
      ),
    },
    async (request, reply) => {
      const input = parseInput(PublishTermVersionSchema, request.body)
      const version = await publishTermVersion(actorOf(request), input)
      return reply.status(201).send(version)
    },
  )

  /**
   * O aceite.
   *
   * **201** quando a linha de consentimento nasceu, **200** quando ela já existia e o
   * que faltava era o papel — o caso do visto marcado no cadastro, que grava a prova sem
   * emitir documento. Repetir o aceite com a prova e o papel prontos é 409.
   */
  app.post<{ Params: TutorParams }>(
    '/v1/tutors/:id/term-acceptances',
    { preHandler: requirePermission('tutor:update') },
    async (request, reply) => {
      const input = parseInput(AcceptTermSchema, request.body)
      const result = await acceptTerm(actorOf(request), request.params.id, input, input.source)
      return reply.status(result.created ? 201 : 200).send(result.acceptance)
    },
  )

  app.get<{ Params: TutorParams }>(
    '/v1/tutors/:id/documents',
    { preHandler: requirePermission('tutor:read') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { documents: await listTutorDocuments(auth.tenantId, request.params.id) }
    },
  )

  /**
   * O detalhe traz a URL assinada de 15 minutos, e pedi-la **é** o download — é esta
   * chamada que entra na trilha de auditoria do §9.
   *
   * Não há rota `/pdf` com 302, pelo mesmo motivo do receituário: o gateway encaminha com
   * `redirect: 'follow'`, consumiria o redirecionamento e traria os bytes pela rede
   * interna — exatamente o que a URL assinada existe para evitar.
   */
  app.get<{ Params: TutorParams & { documentId: string } }>(
    '/v1/tutors/:id/documents/:documentId',
    { preHandler: requirePermission('tutor:read') },
    async (request) =>
      getTutorDocument(actorOf(request), request.params.id, request.params.documentId),
  )
}
