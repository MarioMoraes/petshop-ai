import { AppError, EnqueueMessageSchema, type PortalChannel } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { MESSAGING_DISABLED_CODE } from '../messaging/errors.js'
import { enqueueMessage } from '../messaging/messages.js'

/**
 * A porta para o MOD-NOTIF, do lado do Portal.
 *
 * Era um salto HTTP com contexto assinado, no molde da porta do MOD-CRM. Com os dois
 * módulos no mesmo processo virou chamada de função, e o corte de responsabilidade que
 * motivava o salto continua de pé: este módulo decide **quando pedir um código**, aquele
 * sabe **como entregar**.
 *
 * O ator vai **sem `actorUserId`**, como ia sem `userId` no contexto assinado: quem pediu
 * foi o Portal em nome de alguém que ainda não é ninguém no sistema — a conta do Clerk
 * existe, a ficha ainda não foi vinculada. Atribuir o envio a um usuário seria mentir na
 * trilha.
 *
 * `urgent: true` é o que separa este envio de todos os outros do sistema: o código não pode
 * ser agrupado dentro de outra mensagem nem esperar o tique do worker. Dez minutos de
 * validade não sobrevivem a uma fila.
 *
 * `enqueue` **nunca lança**. Falha de mensageria não pode virar 500 na porta pública: isso
 * contaria, pelo status, que a ficha existe — a resposta é 202 nos dois casos, e a falha
 * vira log.
 */

export interface AccessCodeRequest {
  tenantId: string
  tutorId: string
  channel: PortalChannel
  code: string
  dedupeKey: string
}

/**
 * O código que confirma um contato **novo** (MOD-PORTAL-09, AC-02).
 *
 * `address` é o que distingue este pedido do anterior: o destino ainda não está na ficha,
 * e mandar o código para o contato antigo provaria a posse justamente do contato que o
 * tutor quer trocar. É o único uso de `overrideAddress` no sistema — as guardas que o
 * contêm estão em `modules/messaging/messages.ts`.
 */
export interface ContactCodeRequest {
  tenantId: string
  tutorId: string
  channel: PortalChannel
  address: string
  code: string
  dedupeKey: string
}

export interface WelcomeRequest {
  tenantId: string
  tutorId: string
  portalUrl: string
  dedupeKey: string
}

export interface PortalMessagingPort {
  sendAccessCode(request: AccessCodeRequest): Promise<boolean>
  sendContactCode(request: ContactCodeRequest): Promise<boolean>
  sendWelcome(request: WelcomeRequest): Promise<boolean>
}

function createInProcessPort(): PortalMessagingPort {
  async function enqueue(tenantId: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      /**
       * **Passa pelo mesmo schema que a rota usa**, e não direto ao `enqueueMessage`.
       *
       * `EnqueueMessageSchema` não só valida: ele preenche `recipientKind`, `channel` e
       * `urgent` com os defaults do contrato. Montar o objeto à mão aqui faria o Portal
       * enfileirar com um recorte diferente do que a mesma chamada por HTTP produzia — a
       * diferença que o salto de rede escondia atrás da serialização.
       */
      const input = EnqueueMessageSchema.parse(body)
      await enqueueMessage({ tenantId }, input)
      return true
    } catch (error) {
      if (error instanceof AppError && error.code === MESSAGING_DISABLED_CODE) {
        /**
         * Mensageria desligada no tenant.
         *
         * É **erro**, e não `debug` como no MOD-CRM: lá, uma automação silenciada é
         * configuração; aqui, é o Portal inteiro inacessível para todo cliente deste
         * petshop, sem que nada apareça em tela nenhuma. O log é o único lugar onde essa
         * combinação se denuncia.
         */
        logger.error(
          { tenantId },
          'mensageria desligada: nenhum tutor deste tenant consegue acessar o Portal',
        )
        return false
      }

      logger.error({ err: error, tenantId }, 'falha ao enfileirar a mensagem do Portal')
      return false
    }
  }

  return {
    sendAccessCode(request) {
      return enqueue(request.tenantId, {
        tutorId: request.tutorId,
        templateKey: 'portal_codigo_acesso',
        channel: request.channel,
        dedupeKey: request.dedupeKey,
        variables: { 'portal.codigo': request.code },
        urgent: true,
      })
    },

    sendContactCode(request) {
      return enqueue(request.tenantId, {
        tutorId: request.tutorId,
        templateKey: 'portal_codigo_contato',
        // Explícito, e não `AUTO`: o MOD-NOTIF recusa destino imposto sem canal, porque
        // escolher o canal sozinho o faria cair para o contato **da ficha**.
        channel: request.channel,
        overrideAddress: request.address,
        dedupeKey: request.dedupeKey,
        variables: { 'portal.codigo': request.code },
        urgent: true,
      })
    },

    sendWelcome(request) {
      return enqueue(request.tenantId, {
        tutorId: request.tutorId,
        templateKey: 'portal_boas_vindas',
        dedupeKey: request.dedupeKey,
        variables: { 'portal.link': request.portalUrl },
      })
    },
  }
}

let port: PortalMessagingPort | null = null

export function getMessagingPort(): PortalMessagingPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setMessagingPort(next: PortalMessagingPort | null): void {
  port = next
}
