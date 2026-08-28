import type { ChannelPort } from './registry.js'

/**
 * WhatsApp — **fatia 2** (MOD-CRM-01 e MOD-CRM-09).
 *
 * O provedor decidido é a **Evolution API auto-hospedada**: pareamento por QR code do
 * número do próprio petshop, sem aprovação de template pela Meta e sem custo por
 * mensagem. A contrapartida assumida é real — é camada não-oficial sobre o WhatsApp
 * Web, e o número pode ser banido —, e é ela que justifica a janela de silêncio, o
 * teto diário, o aquecimento de 7 dias e o jitter entre disparos que já estão
 * implementados em `dispatch.ts` e `window.ts`, à espera deste canal.
 *
 * Enquanto não existe, a porta é **declarada e indisponível**: a cascata de `AUTO`
 * simplesmente cai para o e-mail, e a queda é exercitada por teste desde já.
 */

let port: ChannelPort | null = null

function createUnavailablePort(): ChannelPort {
  return {
    available: false,
    async send() {
      return {
        ok: false,
        providerMessageId: null,
        provider: 'whatsapp',
        permanent: true,
        errorCode: 'CHANNEL_UNAVAILABLE',
        errorDetail: 'O canal WhatsApp ainda não está conectado neste estabelecimento',
      }
    },
  }
}

export function getWhatsAppPort(): ChannelPort {
  port ??= createUnavailablePort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setWhatsAppPort(next: ChannelPort | null): void {
  port = next
}
