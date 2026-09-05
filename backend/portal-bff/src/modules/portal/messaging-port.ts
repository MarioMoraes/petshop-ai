import { signServiceHeaders } from '@petshop/service-auth'
import type { PortalChannel } from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'

/**
 * A porta para o messaging-service, no molde da que o crm-automation-service já usa.
 *
 * O contexto assinado é montado aqui, com o mesmo HMAC do gateway, e **sem `userId`**:
 * quem pediu foi o Portal em nome de alguém que ainda não é ninguém no sistema — a
 * conta do Clerk existe, a ficha ainda não foi vinculada. Atribuir o envio a um usuário
 * seria mentir na trilha do outro lado.
 *
 * `urgent: true` é o que separa este envio de todos os outros do sistema: o código não
 * pode ser agrupado dentro de outra mensagem nem esperar o tique do worker. Dez minutos
 * de validade não sobrevivem a uma fila.
 *
 * `enqueue` **nunca lança**. Falha de mensageria não pode virar 500 na porta pública:
 * isso contaria, pelo status, que a ficha existe — a resposta é 202 nos dois casos, e a
 * falha vira log.
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
 * contêm estão em `messages.ts` do messaging-service.
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

const REQUEST_TIMEOUT_MS = 5_000

function createHttpPort(): PortalMessagingPort {
  async function enqueue(
    tenantId: string,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const env = loadEnv()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const headers = signServiceHeaders(
        { clerkUserId: 'svc_portal-bff', tenantId, permissions: [] },
        env.INTERNAL_SERVICE_SECRET,
      )

      const response = await fetch(`${env.MESSAGING_SERVICE_URL}/v1/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (response.status === 409) {
        /**
         * Mensageria desligada no tenant.
         *
         * É **erro**, e não `debug` como no CRM: lá, uma automação silenciada é
         * configuração; aqui, é o Portal inteiro inacessível para todo cliente deste
         * petshop, sem que nada apareça em tela nenhuma. O log é o único lugar onde
         * essa combinação se denuncia.
         */
        logger.error(
          { tenantId },
          'mensageria desligada: nenhum tutor deste tenant consegue acessar o Portal',
        )
        return false
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        logger.error(
          { status: response.status, tenantId, detail },
          'messaging-service recusou a mensagem do Portal',
        )
        return false
      }

      return true
    } catch (error) {
      logger.error({ err: error, tenantId }, 'falha ao falar com o messaging-service')
      return false
    } finally {
      clearTimeout(timeout)
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
        // Explícito, e não `AUTO`: o messaging-service recusa destino imposto sem canal,
        // porque escolher o canal sozinho o faria cair para o contato **da ficha**.
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
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setMessagingPort(next: PortalMessagingPort | null): void {
  port = next
}
