import {
  CreateSuppressionSchema,
  EnqueueMessageSchema,
  MessageChannelSchema,
  MessageListQuerySchema,
  MessageStatsQuerySchema,
  PreviewTemplateSchema,
  UpdateMessagingSettingsSchema,
  UpsertMessageTemplateSchema,
} from '@petshop/shared-types'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { resolveWhatsappInstanceByTokenHash, withTenant } from '@petshop/db'
import { hasPermission, requirePermission, requireTenantContext } from '../../auth/context.js'
import { badWebhook, forbidden, invalid, notFound, unauthorized } from '../../lib/errors.js'
import { parseInput } from '../../lib/validate.js'
import type { ActorContext } from './actor.js'
import { cancelMessage, enqueueMessage, retryMessage } from './messages.js'
import { findMessage, listMessages, messageStats } from './queries.js'
import { render } from './render.js'
import { getSettings, toApi, updateSettings } from './settings.js'
import { createSuppression, listSuppressions, removeSuppression } from './suppressions.js'
import { listTemplates, resetTemplate, upsertTemplate } from './templates.js'
import { applyEmailWebhook, verifyResendSignature } from './webhook-email.js'
import {
  applyWebhook,
  connectWhatsapp,
  disconnectWhatsapp,
  getConnection,
  recreateWhatsapp,
  refreshQrCode,
  webhookTokenHash,
} from './whatsapp.js'

/**
 * Rotas do messaging-service (PRD relacionamento_crm_08 §5).
 *
 * O corte de permissão do §9 tem três degraus, e eles não são intercambiáveis:
 * **`crm:read`** vê o histórico (a recepção precisa saber se o lembrete chegou antes
 * de ligar para o tutor), **`crm:configure`** muda texto e janela, **`crm:send`**
 * dispara e reenvia. Configurar é decidir o texto uma vez; disparar é falar com a base
 * agora.
 *
 * `POST /v1/messages` é a exceção: aceita **contexto de serviço** — é por ela que o
 * crm-automation-service entra. Um usuário só chega lá com `crm:send`.
 */

interface IdParams {
  id: string
}

interface TemplateParams {
  key: string
  channel: string
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

/**
 * TODO(MOD-PORTAL): a central de comunicação do tutor (AC-03 de MOD-CRM-10).
 *
 * O tutor deve ver **as suas** mensagens enviadas e entregues, sem as bloqueadas nem
 * os erros técnicos do provedor. Não dá para implementar hoje: o contexto assinado
 * (`ServiceAuthContext`) não carrega `tutorId`, e quem o resolveria é o `portal-bff`,
 * que ainda não existe. Até lá a rota exige `crm:read`, como as demais — a filtragem
 * por dono entra junto com o Portal, num lugar só.
 */

function parseChannel(value: string) {
  const parsed = MessageChannelSchema.safeParse(value.toUpperCase())
  if (!parsed.success) throw invalid('Canal inválido: use WHATSAPP ou EMAIL')
  return parsed.data
}

export async function registerMessagingRoutes(app: FastifyInstance): Promise<void> {
  // ─── Mensagens ─────────────────────────────────────────────────────────────

  /**
   * A única porta de entrada do envio. Responde **200** quando o `dedupeKey` já
   * existia e **202** quando enfileirou — a diferença importa para quem reprocessa
   * evento e quer saber se causou algo.
   */
  app.post('/v1/messages', async (request, reply) => {
    const auth = requireTenantContext(request)
    // Chamada de serviço (sem usuário) passa; usuário precisa de `crm:send`.
    if (auth.userId && !hasPermission(request, 'crm:send')) {
      throw forbidden('Você não tem permissão para disparar mensagens')
    }

    const input = parseInput(EnqueueMessageSchema, request.body)
    const result = await enqueueMessage(actorOf(request), input)
    return reply.status(result.duplicate ? 200 : 202).send(result)
  })

  app.get(
    '/v1/messages',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as mensagens') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(MessageListQuerySchema, request.query)
      return listMessages(auth.tenantId, query)
    },
  )

  app.get(
    '/v1/messages/stats',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver o painel') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(MessageStatsQuerySchema, request.query)
      return messageStats(auth.tenantId, query)
    },
  )

  app.get<{ Params: IdParams }>(
    '/v1/messages/:id',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as mensagens') },
    async (request) => {
      const auth = requireTenantContext(request)
      const message = await findMessage(auth.tenantId, request.params.id)
      if (!message) throw notFound()
      return message
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/messages/:id/retry',
    { preHandler: requirePermission('crm:send', 'Você não tem permissão para reenviar mensagens') },
    async (request, reply) => {
      await retryMessage(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )

  app.post<{ Params: IdParams }>(
    '/v1/messages/:id/cancel',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para cancelar mensagens') },
    async (request, reply) => {
      await cancelMessage(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )

  /** O histórico na ficha do tutor (MOD-CRM-10). */
  app.get<{ Params: { tutorId: string } }>(
    '/v1/tutors/:tutorId/messages',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver as mensagens') },
    async (request) => {
      const auth = requireTenantContext(request)
      const query = parseInput(MessageListQuerySchema, request.query)
      return listMessages(auth.tenantId, { ...query, tutorId: request.params.tutorId })
    },
  )

  // ─── Templates ─────────────────────────────────────────────────────────────

  app.get(
    '/v1/messaging/templates',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver os textos') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { data: await listTemplates(auth.tenantId) }
    },
  )

  app.put<{ Params: TemplateParams }>(
    '/v1/messaging/templates/:key/:channel',
    {
      preHandler: requirePermission('crm:configure', 'Você não tem permissão para editar os textos'),
    },
    async (request) => {
      const input = parseInput(UpsertMessageTemplateSchema, request.body)
      return upsertTemplate(
        actorOf(request),
        request.params.key,
        parseChannel(request.params.channel),
        input,
      )
    },
  )

  /** Volta ao texto de fábrica (ver a nota em `templates.ts`). */
  app.delete<{ Params: TemplateParams }>(
    '/v1/messaging/templates/:key/:channel',
    {
      preHandler: requirePermission('crm:configure', 'Você não tem permissão para editar os textos'),
    },
    async (request) => {
      return resetTemplate(
        actorOf(request),
        request.params.key,
        parseChannel(request.params.channel),
      )
    },
  )

  /**
   * Prévia com dados de exemplo, sem gravar nem enviar. Existe para que o admin veja o
   * texto renderizado **antes** de salvar — a variável errada aparece como buraco na
   * frase, que é mais eloquente que uma lista de nomes válidos.
   */
  app.post(
    '/v1/messaging/templates/preview',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver os textos') },
    async (request) => {
      const input = parseInput(PreviewTemplateSchema, request.body)
      const sample: Record<string, string> = {
        'tutor.nome': 'Ana Souza',
        'tutor.primeiro_nome': 'Ana',
        'petshop.nome': 'Petshop Exemplo',
        'petshop.telefone': '(11) 4002-8922',
        'pets.lista': 'Thor',
        'agendamento.data': 'quinta-feira, 4 de setembro',
        'agendamento.hora': '09:00',
        'agendamento.servico': 'Banho e tosa',
        'agendamento.profissional': 'Bruna',
      }
      const body = render(input.body, sample)
      return {
        subject: input.subject ? render(input.subject, sample).text : null,
        body: body.text,
        missing: body.missing,
      }
    },
  )

  // ─── Configuração ──────────────────────────────────────────────────────────

  app.get(
    '/v1/messaging/settings',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver a configuração') },
    async (request) => {
      const auth = requireTenantContext(request)
      return toApi(await getSettings(auth.tenantId))
    },
  )

  app.patch(
    '/v1/messaging/settings',
    {
      preHandler: requirePermission(
        'crm:configure',
        'Você não tem permissão para configurar as mensagens',
      ),
    },
    async (request) => {
      const input = parseInput(UpdateMessagingSettingsSchema, request.body)
      return toApi(await updateSettings(actorOf(request), input))
    },
  )

  // ─── Conexão do WhatsApp (MOD-CRM-01) ──────────────────────────────────────

  /**
   * O corte de permissão aqui é mais estreito que o de configurar, e de propósito
   * (AC-06): a recepção **vê** o estado do canal — precisa saber por que o lembrete não
   * saiu antes de ligar para o tutor —, mas conectar o número da empresa é ato de dono.
   */
  app.get(
    '/v1/messaging/whatsapp',
    { preHandler: requirePermission('crm:read', 'Você não tem permissão para ver a conexão') },
    async (request) => {
      const auth = requireTenantContext(request)
      return getConnection(auth.tenantId)
    },
  )

  app.post(
    '/v1/messaging/whatsapp/connect',
    {
      preHandler: requirePermission(
        'crm:connect_channel',
        'Conectar o WhatsApp do estabelecimento é uma ação do administrador',
      ),
    },
    async (request, reply) => {
      const auth = requireTenantContext(request)
      // O nome da instância na Evolution é `tenant-<slug>` — ver `instanceNameFor`.
      const tenant = await withTenant(auth.tenantId, (tx) =>
        tx.tenant.findFirstOrThrow({ select: { slug: true } }),
      )
      const result = await connectWhatsapp(actorOf(request), tenant.slug)
      return reply.status(201).send(result)
    },
  )

  /**
   * Recuperação: refaz a instância do zero, identidade e tudo.
   *
   * Vizinha do `connect`, mas caminho separado de propósito — ver `recreateWhatsapp`.
   * O corte de permissão é o mesmo: quem pode ligar o número da empresa é quem pode
   * recomeçá-lo.
   */
  app.post(
    '/v1/messaging/whatsapp/recreate',
    {
      preHandler: requirePermission(
        'crm:connect_channel',
        'Refazer a conexão do WhatsApp é uma ação do administrador',
      ),
    },
    async (request, reply) => {
      const auth = requireTenantContext(request)
      const tenant = await withTenant(auth.tenantId, (tx) =>
        tx.tenant.findFirstOrThrow({ select: { slug: true } }),
      )
      const result = await recreateWhatsapp(actorOf(request), tenant.slug)
      return reply.status(201).send(result)
    },
  )

  /** AC-03: QR novo sem recriar a instância — recriar perderia a sessão. */
  app.post(
    '/v1/messaging/whatsapp/qr',
    {
      preHandler: requirePermission(
        'crm:connect_channel',
        'Conectar o WhatsApp do estabelecimento é uma ação do administrador',
      ),
    },
    async (request) => refreshQrCode(actorOf(request)),
  )

  app.delete(
    '/v1/messaging/whatsapp',
    {
      preHandler: requirePermission(
        'crm:connect_channel',
        'Desconectar o WhatsApp do estabelecimento é uma ação do administrador',
      ),
    },
    async (request) => disconnectWhatsapp(actorOf(request)),
  )

  // ─── Supressões ────────────────────────────────────────────────────────────

  app.get(
    '/v1/messaging/suppressions',
    { preHandler: requirePermission('crm:configure', 'Você não tem permissão para ver a lista') },
    async (request) => {
      const auth = requireTenantContext(request)
      return { data: await listSuppressions(auth.tenantId) }
    },
  )

  app.post(
    '/v1/messaging/suppressions',
    { preHandler: requirePermission('crm:configure', 'Você não tem permissão para editar a lista') },
    async (request, reply) => {
      const input = parseInput(CreateSuppressionSchema, request.body)
      await createSuppression(actorOf(request), input)
      return reply.status(204).send()
    },
  )

  app.delete<{ Params: IdParams }>(
    '/v1/messaging/suppressions/:id',
    { preHandler: requirePermission('crm:configure', 'Você não tem permissão para editar a lista') },
    async (request, reply) => {
      await removeSuppression(actorOf(request), request.params.id)
      return reply.status(204).send()
    },
  )
}

/**
 * O callback da Evolution (RN-11) — **fora** da autenticação de serviço.
 *
 * Registrado à parte porque o provedor não conhece o contrato HMAC do gateway: ele é um
 * container na rede interna mandando um POST. O que autentica é o token, conferido
 * contra o hash guardado na instância — e é o mesmo mecanismo do link de convite do
 * MOD-IDENT-06: o valor cru nunca foi persistido.
 *
 * O caminho começa com `/internal/` e **não** está em nenhum prefixo do proxy do
 * gateway: não há como alcançá-lo de fora do docker.
 */
export async function registerWhatsappWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Querystring: { token?: string } }>(
    '/internal/v1/whatsapp/webhook',
    async (request, reply) => {
      // Cabeçalho **ou** query: versões da Evolution divergem em quais cabeçalhos
      // personalizados repassam, e um webhook que não se identifica é um pareamento que
      // nunca conclui — sem erro em lugar nenhum.
      const token =
        (request.headers['x-webhook-token'] as string | undefined) ?? request.query.token ?? ''
      if (!token) throw badWebhook('Webhook sem token')

      const instance = await resolveWhatsappInstanceByTokenHash(webhookTokenHash(token))
      // Mesma resposta para token inválido e token de instância apagada: a diferença
      // diria a quem tenta se acertou o formato.
      if (!instance) throw badWebhook('Webhook com token desconhecido')

      await applyWebhook(instance.tenantId, request.body as Parameters<typeof applyWebhook>[1])
      // 204 sempre que o token confere, mesmo para evento que não nos interessa: a
      // Evolution reenvia o que não recebe 2xx, e reenviar um `messages.upsert` que
      // ignoramos de propósito encheria a fila dela para sempre.
      return reply.status(204).send()
    },
  )
}

/**
 * O callback do Resend (MOD-NOTIF-10) — **fora** da autenticação de serviço, como o da
 * Evolution, e pelo mesmo motivo: o provedor não conhece o contrato HMAC do gateway.
 *
 * Duas diferenças em relação ao vizinho, e as duas vêm de o Resend ser um serviço na
 * internet e não um container ao lado:
 *
 * - **O caminho precisa ser alcançável de fora**, então ele não pode se apoiar em estar
 *   fechado na rede interna. Quem o protege é inteiramente a assinatura.
 * - **A verificação é sobre o corpo cru.** O `addContentTypeParser` guarda os bytes
 *   originais em `request.rawBody`: o JSON reserializado pelo Fastify tem as mesmas
 *   chaves e outros bytes, e a assinatura é dos bytes.
 */
export async function registerEmailWebhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (request, body, done) => {
        const raw = typeof body === 'string' ? body : body.toString('utf8')
        ;(request as FastifyRequest & { rawBody?: string }).rawBody = raw
        try {
          done(null, raw.length > 0 ? JSON.parse(raw) : {})
        } catch (error) {
          done(error as Error, undefined)
        }
      },
    )

    scope.post('/internal/v1/email/webhook', async (request, reply) => {
      const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? ''
      const valid = verifyResendSignature(
        {
          id: request.headers['svix-id'] as string | undefined,
          timestamp: request.headers['svix-timestamp'] as string | undefined,
          signature: request.headers['svix-signature'] as string | undefined,
        },
        raw,
      )
      // 401 sem processar nada e sem revelar se a mensagem existe (AC-03).
      if (!valid) throw unauthorized('Assinatura do webhook inválida')

      await applyEmailWebhook(request.body as Parameters<typeof applyEmailWebhook>[0])
      // 204 mesmo para o que ignoramos: o Resend reenvia o que não recebe 2xx, e
      // reenviar um `email.opened` que não se rastreia de propósito encheria a fila
      // dele para sempre.
      return reply.status(204).send()
    })
  })
}
