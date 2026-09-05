import { signServiceHeaders } from '@petshop/service-auth'
import {
  AppError,
  CURRENT_TERMS_VERSION,
  ERROR_CATALOG,
  type ConsentsResponse,
  type ErrorCode,
  type PermissionKey,
  type PortalChannel,
} from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { upstreamUnavailable } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

/**
 * A porta para o `tutor-service`, e só para o consentimento (MOD-PORTAL-10).
 *
 * **Por que HTTP, se o Portal lê o banco direto.** Porque gravar consentimento não é
 * gravar uma linha. O `updateConsents` do tutor-service escreve a transição, derruba os
 * caches do tutor — o cartão da ficha no Admin, que a recepção lê no balcão —, publica
 * `tutor.consentimento.concedido` / `.revogado` e registra a trilha. Refazer isso aqui
 * criaria um segundo gravador de consentimento, e o dia em que um dos dois mudasse de
 * regra a prova jurídica passaria a depender de qual tela a pessoa usou.
 *
 * A **leitura** continua sendo banco direto, em `preferences.ts`: ler é recorte, e
 * recorte é o que o BFF faz.
 *
 * **A elevação de permissão é a quarta do módulo, e a primeira que assina escrita.** O
 * papel `TUTOR` não tem `tutor:update`; esta porta assina um contexto que tem. O que a
 * contém:
 *
 * 1. o `tutorId` vem de `requireOwnScope`, nunca do corpo da requisição — o Portal não
 *    tem como nomear ficha alheia, porque a única que ele conhece é a da própria sessão;
 * 2. a única rota chamada é `PUT /v1/tutors/:id/consents`. Nome, CPF, telefone e
 *    endereço continuam fora do alcance do Portal enquanto MOD-PORTAL-09 não existir;
 * 3. `purpose` é sempre `MARKETING` e `source` é sempre `PORTAL`, fixados aqui e não
 *    aceitos do cliente: um pedido forjado com `TRANSACTIONAL` cortaria os avisos de
 *    agendamento do próprio tutor, que é dano disfarçado de preferência;
 * 4. o `userId` assinado é o do tutor, e é ele que aparece em `consent.revoked` na
 *    trilha do outro lado.
 *
 * **O IP e o user agent viajam nos headers**, e não é detalhe de log: `tutor_consents`
 * guarda os dois como *prova* do consentimento (§4 do PRD de tutores). Sem repassá-los,
 * a linha registraria o endereço do contêiner do BFF — uma prova que aponta para nós
 * mesmos. O tutor-service sobe com `trustProxy`, então lê o `x-forwarded-for` daqui.
 */

export interface TutorCaller {
  tenantId: string
  clerkUserId: string
  userId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export interface TutorPort {
  updateMarketingConsent(
    caller: TutorCaller,
    tutorId: string,
    input: { channel: PortalChannel; granted: boolean },
  ): Promise<ConsentsResponse>
}

const REQUEST_TIMEOUT_MS = 10_000

/** O mínimo. Escrever consentimento é editar o tutor; nada além disso é assinado. */
const CONSENT_PERMISSIONS: PermissionKey[] = ['tutor:update']

interface ProblemBody {
  code?: string
  detail?: string
  [key: string]: unknown
}

function createHttpPort(): TutorPort {
  return {
    async updateMarketingConsent(caller, tutorId, input) {
      const env = loadEnv()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      let response: Response
      try {
        const signed = signServiceHeaders(
          {
            clerkUserId: caller.clerkUserId,
            ...(caller.userId ? { userId: caller.userId } : {}),
            tenantId: caller.tenantId,
            permissions: [...CONSENT_PERMISSIONS],
          },
          env.INTERNAL_SERVICE_SECRET,
        )

        response = await fetch(`${env.TUTOR_SERVICE_URL}/v1/tutors/${tutorId}/consents`, {
          method: 'PUT',
          headers: {
            ...signed,
            'content-type': 'application/json',
            ...(caller.ipAddress ? { 'x-forwarded-for': caller.ipAddress } : {}),
            ...(caller.userAgent ? { 'user-agent': caller.userAgent } : {}),
          },
          body: JSON.stringify({
            transitions: [
              {
                channel: input.channel,
                granted: input.granted,
                purpose: 'MARKETING',
                source: 'PORTAL',
                version: CURRENT_TERMS_VERSION,
              },
            ],
          }),
          signal: controller.signal,
        })
      } catch (error) {
        logger.error({ err: error, tutorId }, 'falha ao falar com o tutor-service')
        throw upstreamUnavailable('Não foi possível salvar a preferência agora.')
      } finally {
        clearTimeout(timeout)
      }

      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        const problema = payload as ProblemBody | null
        // Código de fora do catálogo vira 502, como nas outras portas: `new AppError`
        // lê o status do catálogo e estouraria dentro do próprio construtor. Acontece
        // de verdade quando os dois serviços sobem em versões diferentes.
        const conhecido = problema?.code !== undefined && problema.code in ERROR_CATALOG

        if (response.status >= 500 || !conhecido) {
          logger.error(
            { status: response.status, detail: problema?.detail },
            'tutor-service recusou a preferência do Portal',
          )
          throw upstreamUnavailable('Não foi possível salvar a preferência agora.')
        }

        const { code, detail } = problema ?? {}
        throw new AppError(
          code as ErrorCode,
          typeof detail === 'string' ? detail : 'Não foi possível salvar a preferência',
        )
      }

      return payload as ConsentsResponse
    },
  }
}

let port: TutorPort | null = null

export function getTutorPort(): TutorPort {
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTutorPort(next: TutorPort | null): void {
  port = next
}
