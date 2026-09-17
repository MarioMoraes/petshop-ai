import { tenantHasFeature } from '../../../shared/plan.js'
import { getEvolutionPort } from './evolution.js'
import type { ChannelPort } from './registry.js'

/**
 * O canal WhatsApp (MOD-CRM-01 e MOD-CRM-09).
 *
 * Este arquivo é fino de propósito. Tudo o que é política — quando pode enviar, para
 * quem, quanto por dia, o que fazer quando o número cai — já vive em `dispatch.ts`,
 * `window.ts`, `consent.ts` e `whatsapp.ts`. O que sobra aqui é traduzir uma mensagem
 * do produto numa chamada ao provedor e o erro dele de volta.
 *
 * A disponibilidade é **por tenant**: cada petshop pareia o próprio número, e é isso
 * que fez `ChannelPort` deixar de ter um booleano de módulo. Ver `registry.ts`.
 */

function createEvolutionChannel(): ChannelPort {
  return {
    async isAvailable(tenantId) {
      // Número pareado de quem desceu do Pro continua pareado — voltar ao plano não pede
      // QR code de novo. O que o plano decide é se o canal é oferecido: indisponível, o
      // `AUTO` cai para o e-mail, como já cai quando o número desconecta.
      if (!(await tenantHasFeature(tenantId, 'WHATSAPP'))) return false

      // Importado aqui, e não no topo, porque `whatsapp.ts` importa este módulo pelo
      // caminho de envio — o ciclo estático quebraria a subida do serviço.
      const { isWhatsappConnected } = await import('../whatsapp.js')
      return isWhatsappConnected(tenantId)
    },

    async send(request) {
      const { whatsappCredentials } = await import('../whatsapp.js')
      // O que já estava na fila quando o plano desceu volta para ela, como na queda do
      // número: nada se perde, e tudo escoa se o plano voltar.
      const credentials = (await tenantHasFeature(request.tenantId, 'WHATSAPP'))
        ? await whatsappCredentials(request.tenantId)
        : null

      if (!credentials) {
        // Não é falha da mensagem: é o canal que saiu do ar entre o enfileiramento e o
        // despacho. `CHANNEL_UNAVAILABLE` é o código que `dispatch.ts` lê para devolver
        // a mensagem à fila em vez de contar tentativa (AC-04).
        return {
          ok: false,
          providerMessageId: null,
          provider: 'evolution',
          permanent: true,
          errorCode: 'CHANNEL_UNAVAILABLE',
          errorDetail: 'O WhatsApp deste estabelecimento não está conectado',
        }
      }

      const result = await getEvolutionPort().sendText({
        instanceName: credentials.instanceName,
        apiKey: credentials.apiKey,
        to: request.to,
        // O WhatsApp não tem assunto: o corpo já é a mensagem inteira, e os templates
        // de `messaging-seed.ts` são escritos com isso em mente.
        text: request.body,
      })

      if (result.ok) {
        return {
          ok: true,
          providerMessageId: result.providerMessageId,
          provider: 'evolution',
        }
      }

      // AC-05 acontece **em `dispatch.ts`**, e não aqui: derrubar a instância neste
      // ponto marcaria as pendentes como caídas para o e-mail e, logo em seguida, o
      // caminho de falha do worker escreveria por cima da própria mensagem que
      // descobriu o banimento — a única que ficaria para trás. Este arquivo só reporta
      // o que o provedor disse.
      return {
        ok: false,
        providerMessageId: null,
        provider: 'evolution',
        permanent: result.permanent,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
      }
    },
  }
}

let port: ChannelPort | null = null

export function getWhatsAppPort(): ChannelPort {
  port ??= createEvolutionChannel()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setWhatsAppPort(next: ChannelPort | null): void {
  port = next
}
