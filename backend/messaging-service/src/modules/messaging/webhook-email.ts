import { createHmac, timingSafeEqual } from 'node:crypto'
import { getMaintenancePrisma, withTenant } from '@petshop/db'
import type { MessageChannel } from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { publishEvent } from '../../lib/events.js'
import { logger } from '../../lib/logger.js'
import { openCipher } from './crypto.js'
import { suppress } from './suppressions.js'

/**
 * O retorno do Resend (MOD-NOTIF-10).
 *
 * A lacuna que este arquivo fecha: até aqui, `HARD_BOUNCE` só nascia da recusa
 * **síncrona** do provedor — os status de `PERMANENT_STATUSES` em `ports/email.ts`. Mas
 * o caminho normal de um endereço inexistente não é esse. O Resend aceita a mensagem,
 * responde 202, e o bounce chega minutos depois por webhook. Sem alguém escutando, o
 * domínio da instalação acumula entregas a endereços mortos sem que nada apareça em
 * lugar nenhum — que é o caminho mais curto para a caixa de spam.
 *
 * Quatro decisões moram aqui:
 *
 * - **A busca é por `provider_message_id`, fora do tenant.** O provedor não conhece o
 *   conceito e devolve só o id que ele mesmo emitiu; descobrir de quem é a mensagem
 *   precede o contexto. Mesma forma de `dispatchPending`: descobrir é `app_maintenance`,
 *   agir é `withTenant`.
 * - **O endereço sai da mensagem, nunca do payload** (§9). O corpo do webhook traz o
 *   destinatário, e obedecê-lo deixaria quem forjasse uma assinatura escolher **qual**
 *   endereço suprimir.
 * - **Abertura não se registra** (AC-04). Rastrear abertura exige pixel, pixel é
 *   tratamento sem base legal declarada, e o produto não precisa saber se o tutor abriu
 *   o recibo. Entrega e devolução são fato do envio, não comportamento de quem recebe.
 * - **O estado não regride** (AC-05). Webhook chega fora de ordem, e um `delivered`
 *   depois de um `bounced` do mesmo envio é comum. O evento antigo entra em
 *   `message_events`, que é a trilha; o `status` só anda para frente.
 */

interface ResendWebhookPayload {
  type?: unknown
  data?: { email_id?: unknown }
}

/**
 * Os tipos que movem alguma coisa.
 *
 * `email.opened` e `email.clicked` ficam de fora de propósito, e não por esquecimento —
 * ver a RN-11. `email.sent` também: quem grava o `SENT` é o despacho, que sabe o
 * instante exato em que soltou a mensagem.
 */
const HANDLED = new Set([
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.delivery_delayed',
])

/**
 * A janela de tolerância do carimbo.
 *
 * Cinco minutos, que é o padrão do Svix. É o que impede repetição: um POST capturado e
 * reenviado amanhã traz assinatura perfeitamente válida e carimbo velho.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

export interface WebhookHeaders {
  id: string | undefined
  timestamp: string | undefined
  signature: string | undefined
}

/**
 * Verificação da assinatura, no padrão Svix — que é o que o Resend usa.
 *
 * O segredo vem como `whsec_<base64>`; o conteúdo assinado é `id.timestamp.corpo`, e o
 * cabeçalho `svix-signature` traz uma lista de `v1,<base64>` separada por espaço, porque
 * durante uma rotação de segredo as duas assinaturas viajam juntas.
 *
 * A verificação é feita sobre o **corpo cru**, e é por isso que a rota precisa dele: o
 * JSON reserializado pelo Fastify tem as mesmas chaves e outros bytes, e a assinatura é
 * dos bytes.
 */
export function verifyResendSignature(
  headers: WebhookHeaders,
  rawBody: string,
  now: Date = new Date(),
): boolean {
  const secret = loadEnv().RESEND_WEBHOOK_SECRET
  // Sem segredo configurado, **nada passa**. O contrário — aceitar tudo enquanto falta
  // configuração — seria uma porta aberta para suprimir o endereço de qualquer
  // concorrente (AC-03).
  if (!secret) return false
  if (!headers.id || !headers.timestamp || !headers.signature) return false

  const timestamp = Number(headers.timestamp)
  if (!Number.isFinite(timestamp)) return false
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return false
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest()

  return headers.signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) return false
    const candidate = Buffer.from(value, 'base64')
    // `timingSafeEqual` estoura com tamanhos diferentes, e comprimento errado é o
    // primeiro palpite de quem está tentando adivinhar.
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  })
}

/**
 * A ordem canônica de `MessageStatus`, para a regra do AC-05.
 *
 * Não é a ordem do enum: é a de **progresso da entrega**. `FAILED` está acima de
 * `DELIVERED` porque um bounce depois de uma confirmação de entrega ainda é a última
 * palavra do provedor sobre aquele envio.
 */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SCHEDULED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
  DEAD: 6,
}

const DELIVERED_RANK = 3
const FAILED_RANK = 5

export interface WebhookOutcome {
  handled: boolean
  messageId: string | null
}

export async function applyEmailWebhook(
  payload: ResendWebhookPayload,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const type = typeof payload.type === 'string' ? payload.type : ''
  if (!HANDLED.has(type)) return { handled: false, messageId: null }

  const providerMessageId = typeof payload.data?.email_id === 'string' ? payload.data.email_id : ''
  if (!providerMessageId) return { handled: false, messageId: null }

  const rows = await getMaintenancePrisma().$queryRaw<
    { id: string; tenant_id: string; channel: string }[]
  >`
    SELECT id, tenant_id, channel::text AS channel
      FROM messages
     WHERE provider_message_id = ${providerMessageId}
       AND provider = 'resend'
     LIMIT 1
  `
  const found = rows[0]
  if (!found) {
    // Não é erro: pode ser mensagem já expurgada pela retenção, ou outra instalação
    // apontando para o mesmo endpoint. Responder 2xx evita que o Resend reenvie para
    // sempre algo que ninguém vai reconhecer.
    logger.debug({ providerMessageId, type }, 'webhook do Resend sem mensagem correspondente')
    return { handled: false, messageId: null }
  }

  const tenantId = found.tenant_id
  const messageId = found.id
  const channel = found.channel as MessageChannel
  const complaint = type === 'email.complained'

  const complained = await withTenant(tenantId, async (tx) => {
    const message = await tx.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { status: true, recipientKind: true, tutorId: true, toEncrypted: true },
    })
    const rank = STATUS_RANK[message.status] ?? 0

    if (type === 'email.delivered') {
      await tx.messageEvent.create({
        data: { tenantId, messageId, event: 'DELIVERED', occurredAt: now },
      })
      if (rank < DELIVERED_RANK) {
        await tx.message.update({
          where: { id: messageId },
          data: { status: 'DELIVERED', deliveredAt: now },
        })
      }
      return false
    }

    if (type === 'email.delivery_delayed') {
      // Atraso não é falha: o provedor ainda vai tentar. A trilha registra, o status
      // fica onde está — e é por isso que ele é um tipo separado do bounce.
      await tx.messageEvent.create({
        data: { tenantId, messageId, event: 'FAILED', occurredAt: now, raw: { type } },
      })
      return false
    }

    await tx.messageEvent.create({
      data: { tenantId, messageId, event: 'BOUNCED', occurredAt: now, raw: { type } },
    })

    if (rank < FAILED_RANK) {
      await tx.message.update({
        where: { id: messageId },
        data: {
          status: 'FAILED',
          failedAt: now,
          errorCode: complaint ? 'COMPLAINT' : 'BOUNCE',
          errorDetail: type,
        },
      })
    }

    const cipher = await openCipher(tx, tenantId)
    let address = ''
    try {
      address = cipher.decrypt(message.toEncrypted)
    } catch {
      // Endereço já expurgado pela retenção: não há o que suprimir, e o registro do
      // bounce acima já está gravado.
      address = ''
    }
    if (address) {
      await suppress(tx, tenantId, channel, address, complaint ? 'MANUAL' : 'HARD_BOUNCE')
    }

    return complaint && message.recipientKind === 'TUTOR' && Boolean(message.tutorId)
      ? message.tutorId
      : false
  })

  /**
   * AC-02 — reclamação de spam **é opt-out**, e não só supressão técnica.
   *
   * Quem grava a revogação é o tutor-service, dono de `tutor_consents`: o MOD-CRM fixou
   * que este serviço **lê consentimento e nunca o grava**, e dois escritores da trilha
   * jurídica seriam duas verdades sobre a mesma pergunta. O evento é best-effort como
   * todos os deste sistema, e é aceitável aqui porque quem **impede** o próximo envio é
   * a supressão, gravada logo acima, na mesma transação do bounce.
   */
  if (typeof complained === 'string') {
    await publishEvent('mensagem.reclamada', {
      tenantId,
      messageId,
      tutorId: complained,
      recipientKind: 'TUTOR',
      channel,
    })
  }

  return { handled: true, messageId }
}
