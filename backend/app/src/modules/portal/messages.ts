import { withTenant } from '@petshop/db'
import {
  PORTAL_HIDDEN_TEMPLATE_KEYS,
  PORTAL_VISIBLE_MESSAGE_STATUSES,
  type PortalMessage,
  type PortalMessagesQuery,
  type PortalMessagesResponse,
} from '@petshop/shared-types'
import { openCipher, type PortalCipher } from './crypto.js'

/**
 * MOD-PORTAL-10 — o que o petshop me mandou.
 *
 * Leitura pura, e por isso banco direto: a regra da fatia 2 vale inteira. Quem
 * renderiza texto, escolhe canal, agrupa e reenvia é o `messaging-service`; o Portal
 * recorta o que já saiu.
 *
 * **O valor desta rota é o recorte, e o recorte está na consulta.** Três exclusões
 * moram no `where` e não num filtro sobre o resultado, pela mesma razão da nota interna
 * do extrato e do temperamento do pet: um filtro depois da leitura é uma linha que
 * alguém pode remover sem perceber, e o dado já teria atravessado o processo.
 *
 * 1. **Status** — só `SENT`, `DELIVERED` e `READ` (AC-02). O que ficou na fila, o que
 *    falhou no provedor e o que a régua de consentimento barrou não são assunto do
 *    tutor. Ver `PORTAL_VISIBLE_MESSAGE_STATUSES`, onde cada ausência está justificada.
 * 2. **Direção** — só `OUTBOUND`. O `INBOUND` é a resposta que o próprio tutor mandou
 *    pelo WhatsApp, e devolvê-la aqui transformaria a tela numa conversa pela metade:
 *    o Portal não tem campo de resposta, e o canal onde ele respondeu já tem a linha do
 *    tempo inteira no aparelho dele.
 * 3. **Template** — o código de acesso nunca entra, mesmo tendo sido entregue.
 */

export async function listOwnMessages(
  tenantId: string,
  tutorId: string,
  query: PortalMessagesQuery,
): Promise<PortalMessagesResponse> {
  return withTenant(tenantId, async (tx) => {
    const where = {
      tutorId,
      // AC-03 de MOD-NOTIF-11. `tutorId` já bastaria — mensagem de equipe nasce com ele
      // nulo —, e o filtro está aqui como afirmação: o Portal é a superfície do
      // cliente, e o e-mail que ele recebeu como funcionário não é assunto dele ali.
      recipientKind: 'TUTOR' as const,
      direction: 'OUTBOUND' as const,
      status: { in: [...PORTAL_VISIBLE_MESSAGE_STATUSES] },
      templateKey: { notIn: [...PORTAL_HIDDEN_TEMPLATE_KEYS] },
    }

    const [rows, total, settings] = await Promise.all([
      tx.message.findMany({
        where,
        // `sentAt` e não `createdAt`: o que a tela mostra é quando o petshop falou, e
        // uma mensagem agendada nasce dias antes de sair. Ordenar pela criação
        // embaralharia o lembrete de véspera com a promoção que ficou parada na fila.
        orderBy: { sentAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          channel: true,
          category: true,
          subjectEncrypted: true,
          bodyEncrypted: true,
          sentAt: true,
        },
      }),
      tx.message.count({ where }),
      tx.tenantSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    ])

    /**
     * Uma DEK por página, não por linha.
     *
     * `getTenantKey` desembrulha a chave do tenant com a KEK; pedir uma por mensagem
     * faria uma página de vinte custar vinte dessas. Mesmo desenho do histórico do
     * painel, no messaging-service.
     */
    const cipher = rows.length > 0 ? await openCipher(tx, tenantId) : null

    return {
      messages: rows.map((row) => toPortalMessage(row, cipher)),
      page: query.page,
      limit: query.limit,
      total,
      timezone: settings?.timezone ?? 'America/Sao_Paulo',
    }
  })
}

/**
 * O corpo expurgado vira aviso legível, e não erro.
 *
 * A retenção de 24 meses (AC-04 de MOD-CRM-10) e a anonimização **apagam o texto e
 * mantêm a linha**. Um histórico que estourasse ao encontrar uma dessas seria um
 * histórico que só funciona nos dois últimos anos — e a página que quebrasse seria
 * justamente a do cliente mais antigo do petshop.
 */
const CORPO_EXPURGADO = 'Esta mensagem não está mais disponível.'

function toPortalMessage(
  row: {
    id: string
    channel: 'WHATSAPP' | 'EMAIL'
    category: 'TRANSACTIONAL' | 'OPERATIONAL' | 'MARKETING'
    subjectEncrypted: string | null
    bodyEncrypted: string
    sentAt: Date | null
  },
  cipher: PortalCipher | null,
): PortalMessage {
  const assunto = row.subjectEncrypted ? decifrar(cipher, row.subjectEncrypted) : null

  return {
    id: row.id,
    channel: row.channel,
    category: row.category,
    subject: assunto,
    body: decifrar(cipher, row.bodyEncrypted) ?? CORPO_EXPURGADO,
    /**
     * Não é nulo na prática: o filtro de status só deixa passar mensagem que saiu, e
     * `sentAt` é gravado no mesmo update que muda o status. O fallback existe para que
     * um dado torto de migração vire uma data estranha em vez de uma página em branco.
     */
    sentAt: (row.sentAt ?? new Date(0)).toISOString(),
  }
}

/** `null` quando não há o que decifrar ou o texto não abre — nunca estoura. */
function decifrar(cipher: PortalCipher | null, payload: string): string | null {
  if (!cipher || !payload) return null
  try {
    return cipher.decrypt(payload)
  } catch {
    return null
  }
}
