import type { TenantTransaction } from '@petshop/db'
import { DOCUMENT_KIND_LABELS, type DocumentKind } from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { documentStorage, getStorage, StorageUnavailableError } from '../../shared/document-storage.js'

/**
 * O anexo do e-mail (MOD-NOTIF-05).
 *
 * O módulo inteiro existe para responder uma pergunta no instante do envio: **os bytes
 * vão junto, ou vai só o endereço?** As três respostas possíveis não são falha nenhuma —
 * são caminhos previstos, e a mais importante delas é a terceira.
 *
 * 1. **Vão junto.** Documento emitido, canal de e-mail, arquivo dentro do teto.
 * 2. **Espera.** O documento ainda está `PENDING` — o Gotenberg estava fora quando o
 *    assunto aconteceu. Mandar "segue o recibo" sem recibo é pior que atrasar (AC-04).
 * 3. **Vai o endereço.** Arquivo grande demais, canal WhatsApp, bucket indisponível, ou
 *    emissão que desistiu. Falhar a entrega de um recibo por causa do tamanho é pior
 *    que entregá-lo por link.
 * 4. **Não vai.** O documento foi anulado enquanto a mensagem esperava, e aí não houve
 *    impedimento nenhum — foi o assunto que deixou de existir (AC-04 de MOD-NOTIF-06).
 *
 * **O endereço é sempre o da página do Portal, nunca a URL assinada do bucket** (AC-05).
 * URL assinada é credencial, e credencial que atravessa e-mail, log e histórico é
 * credencial vazada. A página do Portal pede a sessão do tutor e assina a URL do lado
 * de lá, onde ela vive por quinze minutos.
 */

/**
 * O teto do anexo (RN-07).
 *
 * Oito megabytes. O limite do Resend é bem mais alto — a documentação fala em 40 MB no
 * corpo inteiro da requisição —, e o número daqui não persegue esse teto: persegue o do
 * **destinatário**. Servidor corporativo que recusa anexo costuma cortar entre 10 e 25
 * MB, e um PDF deste produto que passe de 8 MB é um documento com scan dentro, não um
 * recibo. Acima disso o link entrega melhor que o anexo.
 */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024

export interface Attachment {
  filename: string
  content: Buffer
}

export type AttachmentPlan =
  /** Sem documento, ou documento que deixou de existir: a mensagem segue como texto. */
  | { kind: 'none' }
  /** Documento ainda em preparo. A mensagem espera — ver `dispatch.ts`. */
  | { kind: 'pending' }
  /** O documento foi anulado enquanto a mensagem esperava. O assunto acabou. */
  | { kind: 'cancelled' }
  | { kind: 'file'; attachment: Attachment }
  | { kind: 'link'; reason: 'TOO_LARGE' | 'WHATSAPP' | 'NO_STORAGE' | 'NOT_ISSUED' }

/**
 * Os endereços da instalação, montados do ambiente.
 *
 * Mesma forma que o portal-bff e o tenant-site-service usam, e pela mesma razão: o
 * domínio é lido em tempo de execução, nunca cravado — a imagem não pode nascer
 * amarrada a uma instalação. Em desenvolvimento não há subdomínio por tenant, e tudo
 * cai no host único.
 *
 * **O Admin sai por `app.`**, e não pelo subdomínio do petshop: é a decisão de
 * 2026-08-28, e ela é de segurança. O site público é a superfície mais exposta do
 * sistema, e o cookie de sessão da equipe não divide origem com ela.
 */
function baseUrl(): { protocol: string; domain: string; local: boolean } {
  const domain = loadEnv().APP_DOMAIN
  const local = domain.startsWith('localhost')
  return { protocol: local ? 'http' : 'https', domain, local }
}

export function siteUrlOf(slug: string): string {
  const { protocol, domain, local } = baseUrl()
  return local ? `${protocol}://${domain}` : `${protocol}://${slug}.${domain}`
}

export function portalUrlOf(slug: string): string {
  return `${siteUrlOf(slug)}/portal`
}

/** "Meus Documentos" no Portal deste petshop. */
export function documentsUrlOf(slug: string): string {
  return `${portalUrlOf(slug)}/documentos`
}

export function adminUrlOf(): string {
  const { protocol, domain, local } = baseUrl()
  return local ? `${protocol}://${domain}/dashboard` : `${protocol}://app.${domain}/dashboard`
}

/** `recibo-2026-000123.pdf` — o nome que o tutor vê no cliente de e-mail. */
function filenameFor(kind: DocumentKind, number: string): string {
  const label = (DOCUMENT_KIND_LABELS[kind] ?? 'documento')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return `${label}-${number.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`
}

/**
 * Decide o que fazer com o documento desta mensagem.
 *
 * Roda **no despacho** e não no enfileiramento, e a diferença importa: entre uma coisa
 * e outra o documento pode ter sido emitido, cancelado ou reprocessado, e a decisão
 * precisa valer para o instante do envio.
 */
export async function planAttachment(
  tx: TenantTransaction,
  options: { tenantId: string; documentId: string | null; channel: 'WHATSAPP' | 'EMAIL' },
): Promise<AttachmentPlan> {
  if (!options.documentId) return { kind: 'none' }

  // AC-03: arquivo pela Evolution cai nas regras de mídia, engorda a fila e some do
  // histórico do tutor. O WhatsApp leva link, sempre (RN-06).
  if (options.channel === 'WHATSAPP') return { kind: 'link', reason: 'WHATSAPP' }

  const document = await tx.document.findUnique({
    where: { id: options.documentId },
    select: { kind: true, number: true, status: true, storageKey: true, sizeBytes: true },
  })

  // O documento sumiu do tenant: a mensagem não é refém dele. O texto já foi
  // renderizado e diz o que precisa dizer.
  if (!document) return { kind: 'none' }
  if (document.status === 'PENDING') return { kind: 'pending' }

  /**
   * Anulado entre a fila e o envio (AC-04 de MOD-NOTIF-06).
   *
   * `CANCELLED`, e não `BLOCKED`: não houve impedimento do destinatário — o recibo que
   * motivava a mensagem deixou de existir. É a mesma distinção que a fatia 3 do MOD-CRM
   * fixou para o saldo quitado na régua de cobrança.
   */
  if (document.status === 'CANCELLED') return { kind: 'cancelled' }

  /**
   * A emissão desistiu. O link continua entregando alguma coisa — a página do Portal
   * dirá "em preparo" — e é melhor que o alternativo: `pending` aqui faria a mensagem
   * voltar à fila a cada cinco minutos, para sempre, sem consumir tentativa nenhuma.
   */
  if (document.status === 'FAILED' || !document.storageKey) {
    return { kind: 'link', reason: 'NOT_ISSUED' }
  }

  if ((document.sizeBytes ?? 0) > ATTACHMENT_MAX_BYTES) {
    return { kind: 'link', reason: 'TOO_LARGE' }
  }
  if (!documentStorage.isConfigured()) return { kind: 'link', reason: 'NO_STORAGE' }

  try {
    const content = await getStorage().read(document.storageKey)
    // O tamanho gravado pode estar desatualizado — um reprocesso troca o arquivo sem
    // que nada garanta que a coluna acompanhou. Quem decide é o que veio.
    if (content.byteLength > ATTACHMENT_MAX_BYTES) return { kind: 'link', reason: 'TOO_LARGE' }
    return {
      kind: 'file',
      attachment: { filename: filenameFor(document.kind, document.number), content },
    }
  } catch (error) {
    // Bucket fora do ar não segura o recibo: o link continua entregando, e insistir
    // renderia cinco tentativas para um problema que não é da mensagem.
    if (!(error instanceof StorageUnavailableError)) throw error
    logger.error(
      { err: error, documentId: options.documentId },
      'falha ao ler o anexo; o e-mail sai com link',
    )
    return { kind: 'link', reason: 'NO_STORAGE' }
  }
}
