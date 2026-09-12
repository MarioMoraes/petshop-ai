import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * A assinatura Svix, conferida sobre o corpo cru.
 *
 * Mora no núcleo do processo porque **dois** provedores a usam: o Resend, no retorno de
 * entrega de e-mail (MOD-NOTIF-10), e o Clerk, na sincronização de usuário
 * (MOD-IDENT-03). Os dois mandam os mesmos três cabeçalhos e o mesmo `whsec_<base64>`;
 * duas cópias da mesma verificação divergiriam, e a divergência apareceria como um furo
 * de autenticação numa superfície pública.
 *
 * O que muda por provedor é só de onde sai o segredo, e isso fica com quem chama.
 */

export interface SvixHeaders {
  id: string | undefined
  timestamp: string | undefined
  signature: string | undefined
}

/**
 * A janela de tolerância do carimbo.
 *
 * Cinco minutos, que é o padrão do Svix. É o que impede repetição: um POST capturado e
 * reenviado amanhã traz assinatura perfeitamente válida e carimbo velho.
 */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

/**
 * O conteúdo assinado é `id.timestamp.corpo`, e o cabeçalho `svix-signature` traz uma
 * lista de `v1,<base64>` separada por espaço, porque durante uma rotação de segredo as
 * duas assinaturas viajam juntas.
 *
 * A verificação é feita sobre o **corpo cru**, e é por isso que a rota precisa dele: o
 * JSON reserializado pelo Fastify tem as mesmas chaves e outros bytes, e a assinatura é
 * dos bytes.
 */
export function verifySvixSignature(input: {
  secret: string | undefined
  headers: SvixHeaders
  rawBody: string
  now?: Date
}): boolean {
  const { secret, headers, rawBody } = input
  const now = input.now ?? new Date()

  // Sem segredo configurado, **nada passa**. O contrário — aceitar tudo enquanto falta
  // configuração — é uma porta aberta com a chave na fechadura.
  if (!secret) return false
  if (!headers.id || !headers.timestamp || !headers.signature) return false

  const timestamp = Number(headers.timestamp)
  if (!Number.isFinite(timestamp)) return false
  if (
    Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > SVIX_TIMESTAMP_TOLERANCE_SECONDS
  ) {
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
