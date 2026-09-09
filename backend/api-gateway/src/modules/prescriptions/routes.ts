import { CreatePrescriptionSchema, VoidPrescriptionSchema } from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePermission, requireTenantContext } from '../records/auth.js'
import { parseInput } from '../records/validate.js'
import type { ActorContext } from '../records/actor.js'
import {
  createPrescription,
  getPrescription,
  listPrescriptions,
  voidPrescription,
} from './service.js'

/**
 * Rotas do receituário (PRD documentos_pdf_11 §5).
 *
 * **Nenhuma permissão nova.** A permissão de um documento é a permissão do assunto dele:
 * receituário é `record:read` / `record:write`, extrato é `finance:read`, termo é
 * `tutor:read`. Criar um `document:read` faria quem tem acesso a documentos ler
 * prontuário por um caminho lateral.
 *
 * A leitura pede `record:read` — o prontuário **completo**, e não o
 * `record:read_summary` do resumo: a posologia é conteúdo clínico, e é justamente o que
 * o AC-02 do MOD-PRONT-02 mantém fora do alcance de quem só vê o recorte operacional.
 *
 * **Não há PATCH.** A ausência é a regra: receituário emitido não se edita, nem dentro
 * das 24h que o MOD-PRONT concede ao atendimento. Corrigir é anular e emitir outra.
 */

interface IdParams {
  id: string
}

interface PetParams {
  petId: string
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

export async function registerPrescriptionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A emissão pede `record:write` — e o gate que decide de verdade é o CRMV, dentro do
   * serviço. Nenhum papel tem "pode prescrever": o que autoriza é o registro no
   * conselho, e ele é do profissional, não do papel de acesso.
   */
  app.post<{ Params: IdParams }>(
    '/v1/attendances/:id/prescriptions',
    {
      preHandler: requirePermission(
        'record:write',
        'Emitir receituário é do veterinário — e exige CRMV cadastrado',
      ),
    },
    async (request, reply) => {
      const input = parseInput(CreatePrescriptionSchema, request.body)
      const prescription = await createPrescription(actorOf(request), request.params.id, input)
      return reply.status(201).send(prescription)
    },
  )

  app.get<{ Params: PetParams }>(
    '/v1/pets/:petId/prescriptions',
    { preHandler: requirePermission('record:read') },
    async (request) => {
      const prescriptions = await listPrescriptions(actorOf(request), {
        petId: request.params.petId,
      })
      return { prescriptions }
    },
  )

  app.get<{ Params: IdParams }>(
    '/v1/attendances/:id/prescriptions',
    { preHandler: requirePermission('record:read') },
    async (request) => {
      const prescriptions = await listPrescriptions(actorOf(request), {
        attendanceId: request.params.id,
      })
      return { prescriptions }
    },
  )

  /**
   * O detalhe traz a URL assinada de 15 minutos, e pedi-la **é** o download — é esta
   * chamada que entra na trilha de auditoria do §9.
   *
   * O PRD desenha aqui um `/pdf` que responde 302. Ele não nasce porque o gateway segue
   * redirecionamento por conta própria (`fetch` com `redirect: 'follow'`): o 302 seria
   * consumido lá dentro e os bytes do arquivo voltariam pela rede interna, que é
   * exatamente o que a URL assinada existe para evitar. O endereço desce no corpo, e o
   * navegador vai ao bucket direto — é o mesmo caminho que o recibo já usa desde o
   * MOD-LEDGER.
   */
  app.get<{ Params: IdParams }>(
    '/v1/prescriptions/:id',
    { preHandler: requirePermission('record:read') },
    async (request) => getPrescription(actorOf(request), request.params.id),
  )

  /**
   * Anular é `record:void`, como o atendimento: a diferença entre corrigir e anular é
   * que a anulação declara sem efeito um papel que já saiu pela porta.
   */
  app.post<{ Params: IdParams }>(
    '/v1/prescriptions/:id/void',
    {
      preHandler: requirePermission(
        'record:void',
        'Anular receituário é do administrador ou do veterinário',
      ),
    },
    async (request) => {
      const input = parseInput(VoidPrescriptionSchema, request.body)
      return voidPrescription(actorOf(request), request.params.id, input)
    },
  )
}
