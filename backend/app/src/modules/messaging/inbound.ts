import { Prisma, hashSearchable, withTenant, type TenantTransaction } from '@petshop/db'
import {
  AGENT_INBOUND_LABELS,
  InvalidPhoneError,
  TUTOR_PHONE_HASH_NAMESPACE,
  normalizePhoneBR,
  type AgentInboundKind,
} from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { openCipher } from './crypto.js'
import { getAgentInboundPort } from './ports/agent.js'

/**
 * A mensagem que **chega** (MOD-AI-01).
 *
 * O `INBOUND` de `MessageDirection` existia desde o MOD-NOTIF e nenhuma linha do sistema
 * escrevia uma: o webhook da Evolution tratava `QRCODE_*` e `CONNECTION_*` e descartava
 * o resto, então o canal só sabia falar. Este arquivo é a metade que faltava.
 *
 * Ele faz três coisas, e para de fazer qualquer outra:
 *
 * 1. **Traduz o vocabulário do provedor.** `remoteJid`, `messageType`,
 *    `extendedTextMessage` morrem aqui. Nada depois deste arquivo sabe o que é a
 *    Evolution.
 * 2. **Grava a linha em `messages`**, com a idempotência garantida pelo índice único
 *    parcial sobre `(tenant_id, provider_message_id)` — e não por um `SELECT` antes do
 *    `INSERT`, que perde a corrida justamente na rajada em que o provedor reentrega.
 * 3. **Entrega o fato à porta do MOD-AI**, que decide o que a conversa vira.
 *
 * O que ele **não** faz: responder. Quem responde é o agente (na fatia seguinte) ou a
 * recepção, pela tela. Um webhook que respondesse direto contornaria a fila, o teto de
 * vazão e o histórico — os três motivos de o motor do MOD-NOTIF existir (RN-15).
 */

/** Os nomes do evento nas versões da Evolution que o produto já viu. */
const MESSAGE_EVENTS = new Set(['messages.upsert', 'MESSAGES_UPSERT'])

/**
 * Do `messageType` da Evolution para o que a conversa entende.
 *
 * O que não está no mapa vira `OTHER` de propósito: enquete, localização, figurinha e o
 * que o WhatsApp inventar no mês que vem entram todos no mesmo balde, e o balde tem
 * tratamento — vai para a recepção. Uma lista exaustiva envelheceria em silêncio.
 */
const KIND_BY_TYPE: Record<string, AgentInboundKind> = {
  conversation: 'TEXT',
  extendedTextMessage: 'TEXT',
  audioMessage: 'AUDIO',
  pttMessage: 'AUDIO',
  imageMessage: 'IMAGE',
  videoMessage: 'VIDEO',
  documentMessage: 'DOCUMENT',
  documentWithCaptionMessage: 'DOCUMENT',
}

export interface InboundPayload {
  event?: string
  data?: unknown
}

interface EvolutionMessage {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string }
  messageType?: string
  messageTimestamp?: number | string
  message?: Record<string, unknown>
}

export function isInboundEvent(event: string): boolean {
  return MESSAGE_EVENTS.has(event)
}

/**
 * Trata `messages.upsert`. Nunca lança: o webhook responde 204 sempre que o token
 * confere, e a Evolution reenvia para sempre o que não recebe 2xx.
 */
export async function receiveInboundMessage(
  tenantId: string,
  payload: InboundPayload,
): Promise<void> {
  try {
    const parsed = parseMessage(payload.data)
    if (!parsed) return
    await store(tenantId, parsed)
  } catch (error) {
    // Uma mensagem recebida que estoura não pode derrubar o webhook: a Evolution
    // reentregaria a mesma para sempre, e o pareamento inteiro (que compartilha o
    // endpoint) iria junto.
    logger.error({ err: error, tenantId }, 'Falha ao processar mensagem recebida')
  }
}

interface ParsedMessage {
  providerMessageId: string
  phone: string
  kind: AgentInboundKind
  text: string
  receivedAt: Date
}

function parseMessage(data: unknown): ParsedMessage | null {
  // Algumas versões entregam `data` como array de um elemento; outras, como objeto.
  const raw = (Array.isArray(data) ? data[0] : data) as EvolutionMessage | undefined
  const key = raw?.key
  if (!raw || !key?.id || !key.remoteJid) return null

  // O eco da própria mensagem que acabamos de enviar. Gravá-la criaria uma segunda
  // linha para cada envio do motor, e um turno do tutor dizendo o que o petshop falou.
  if (key.fromMe) return null

  // Grupo e status não são conversa com cliente. `@g.us` é grupo; `status@broadcast` é
  // o "status" do WhatsApp, que chega a quem tem o número na agenda.
  if (!key.remoteJid.endsWith('@s.whatsapp.net')) return null

  const digits = key.remoteJid.split('@')[0]?.replace(/\D/g, '') ?? ''
  if (!digits) return null

  const kind = KIND_BY_TYPE[raw.messageType ?? ''] ?? 'OTHER'
  const text = kind === 'TEXT' ? extractText(raw.message) : ''

  return {
    providerMessageId: key.id,
    phone: toE164(digits),
    kind,
    text,
    receivedAt: toDate(raw.messageTimestamp),
  }
}

/**
 * O telefone como o cadastro o guarda.
 *
 * `normalizePhoneBR` é o mesmo que o MOD-TUTOR aplica na ficha, e é o que faz o número
 * sem o nono dígito — que o WhatsApp ainda entrega assim para linha antiga — casar com a
 * ficha que o tem. O que ele recusa (número estrangeiro, DDD que não existe) vira E.164
 * cru: não vai casar com ficha nenhuma, e é exatamente o caminho do AC-02.
 */
function toE164(digits: string): string {
  try {
    return normalizePhoneBR(digits)
  } catch (error) {
    if (error instanceof InvalidPhoneError) return `+${digits}`
    throw error
  }
}

function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return ''
  const direct = message.conversation
  if (typeof direct === 'string') return direct.slice(0, 4000)
  const extended = message.extendedTextMessage
  if (extended && typeof extended === 'object') {
    const inner = (extended as { text?: unknown }).text
    if (typeof inner === 'string') return inner.slice(0, 4000)
  }
  return ''
}

function toDate(timestamp: number | string | undefined): Date {
  const seconds = typeof timestamp === 'string' ? Number.parseInt(timestamp, 10) : timestamp
  if (!seconds || !Number.isFinite(seconds)) return new Date()
  const parsed = new Date(seconds * 1000)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

async function store(tenantId: string, parsed: ParsedMessage): Promise<void> {
  const phoneHash = hashSearchable(TUTOR_PHONE_HASH_NAMESPACE, parsed.phone)

  const result = await withTenant(tenantId, async (tx) => {
    /**
     * O atalho da reentrega (AC-04).
     *
     * A garantia é o índice único parcial, logo abaixo — esta consulta não a substitui,
     * porque ela perde a corrida entre duas entregas simultâneas. O que ela evita é o
     * caso comum: a Evolution reentrega em rajada o que já foi processado, e sem o
     * atalho cada reentrega produziria uma violação de unicidade no log de erro do
     * Prisma. Um log cheio de erro esperado é um log que ninguém lê.
     */
    const known = await tx.message.findFirst({
      where: { direction: 'INBOUND', providerMessageId: parsed.providerMessageId },
      select: { id: true },
    })
    if (known) return null

    const candidates = await findTutorsByPhone(tx, phoneHash)
    const cipher = await openCipher(tx, tenantId)

    /**
     * O corpo guardado é o texto, e nunca o conteúdo de mídia (AC-05).
     *
     * Um áudio vira `(áudio)` — o suficiente para a fila dizer do que se trata, e nada
     * do que foi dito. Transcrever é da triagem clínica, que é outro agente e outra
     * fase.
     */
    const body =
      parsed.kind === 'TEXT' && parsed.text ? parsed.text : `(${AGENT_INBOUND_LABELS[parsed.kind]})`

    try {
      const message = await tx.message.create({
        data: {
          tenantId,
          direction: 'INBOUND',
          channel: 'WHATSAPP',
          category: 'OPERATIONAL',
          // Só quando há **uma** ficha: o telefone em duas fichas não se desempata
          // aqui, e atribuir a linha a uma delas daria a essa pessoa a conversa da
          // outra (AC-03).
          ...(candidates.length === 1 ? { tutorId: candidates[0] } : {}),
          templateKey: 'inbound',
          // `to_*` guarda o **outro lado** da mensagem, e no `INBOUND` o outro lado é
          // quem escreveu. O comentário da coluna, escrito no MOD-NOTIF, já previa
          // isto: o hash "casa supressão e inbound sem precisar decifrar linha por
          // linha".
          toEncrypted: cipher.encrypt(parsed.phone),
          toHash: phoneHash,
          bodyEncrypted: cipher.encrypt(body),
          status: 'DELIVERED',
          deliveredAt: parsed.receivedAt,
          dedupeKey: `inbound:${parsed.providerMessageId}`.slice(0, 120),
          provider: 'evolution',
          providerMessageId: parsed.providerMessageId.slice(0, 120),
        },
        select: { id: true },
      })
      return { messageId: message.id, candidates }
    } catch (error) {
      // AC-04: a reentrega da Evolution. O índice único parcial é quem barra, e
      // chegar aqui significa que a mensagem já foi processada — inclusive a conversa.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null
      }
      throw error
    }
  })

  if (!result) return

  await getAgentInboundPort().onInbound({
    tenantId,
    messageId: result.messageId,
    phone: parsed.phone,
    phoneHash,
    tutorId: result.candidates.length === 1 ? (result.candidates[0] ?? null) : null,
    candidates: result.candidates,
    kind: parsed.kind,
    text: parsed.text,
    receivedAt: parsed.receivedAt,
  })
}

/**
 * As fichas que casam com o telefone — pelo principal **e** pelo alternativo.
 *
 * O segundo número da ficha é telefone do tutor como o primeiro, e quem escreve do
 * celular do trabalho não deixa de ser cliente. Fichas unificadas (`MERGED`) ficam de
 * fora: elas apontam para outra, e contá-las faria todo telefone unificado parecer
 * ambíguo.
 */
async function findTutorsByPhone(tx: TenantTransaction, phoneHash: string): Promise<string[]> {
  const rows = await tx.tutor.findMany({
    where: {
      status: { not: 'MERGED' },
      OR: [{ phoneHash }, { phoneAltHash: phoneHash }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  })
  return rows.map((row) => row.id)
}
