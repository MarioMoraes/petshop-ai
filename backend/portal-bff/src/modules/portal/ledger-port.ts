import { signServiceHeaders } from '@petshop/service-auth'
import {
  AppError,
  ERROR_CATALOG,
  type ErrorCode,
  type PermissionKey,
  type PortalReceiptResponse,
} from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { upstreamUnavailable } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

/**
 * A porta para o `billing-ledger-service`, e só para o recibo.
 *
 * **Por que HTTP, se o extrato lê o banco direto.** Porque pedir o recibo não é ler: o
 * `GET /v1/payments/:id/receipt` do ledger **emite** o PDF quando ele ainda não existe
 * — renderiza o documento no Gotenberg, grava no bucket, muda o status para `ISSUED`,
 * publica `recibo.emitido` e escreve na trilha. Refazer isso aqui seria uma segunda
 * emissora de documento contábil, com um segundo contador de tentativas.
 *
 * O resto do módulo continua lendo direto: saldo, lançamentos e pacotes são recorte, e
 * recorte é o que o BFF faz.
 *
 * **A elevação de permissão é a mesma da `scheduling-port` e tem o mesmo contorno.** O
 * papel `TUTOR` não tem `finance:read`; esta porta assina um contexto que tem. O que a
 * segura:
 *
 * 1. a posse do pagamento é provada **antes** da chamada (`ownsPayment`, em
 *    `finance.ts`), com o recorte na consulta e 404 para o que não é dele;
 * 2. só `finance:read` é assinado — nunca `finance:create`, `finance:refund` ou
 *    `finance:credit`. O tutor não registra pagamento, não estorna e não concede
 *    crédito a si mesmo;
 * 3. o `userId` assinado é o do tutor, e é ele que aparece na trilha do outro lado.
 */

export interface LedgerCaller {
  tenantId: string
  clerkUserId: string
  userId?: string | undefined
}

export interface LedgerPort {
  receipt(caller: LedgerCaller, paymentId: string): Promise<PortalReceiptResponse>
}

const REQUEST_TIMEOUT_MS = 15_000

/** O mínimo. Ler o recibo é leitura financeira; nada além disso é assinado. */
const READ_PERMISSIONS: PermissionKey[] = ['finance:read']

interface ProblemBody {
  code?: string
  detail?: string
  [key: string]: unknown
}

function createHttpPort(): LedgerPort {
  return {
    async receipt(caller, paymentId) {
      const env = loadEnv()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      let response: Response
      try {
        const headers = signServiceHeaders(
          {
            clerkUserId: caller.clerkUserId,
            ...(caller.userId ? { userId: caller.userId } : {}),
            tenantId: caller.tenantId,
            permissions: [...READ_PERMISSIONS],
          },
          env.INTERNAL_SERVICE_SECRET,
        )

        response = await fetch(
          `${env.BILLING_LEDGER_SERVICE_URL}/v1/payments/${paymentId}/receipt`,
          { method: 'GET', headers, signal: controller.signal },
        )
      } catch (error) {
        logger.error({ err: error, paymentId }, 'falha ao falar com o billing-ledger-service')
        throw upstreamUnavailable('Não foi possível obter o recibo agora. Tente em instantes.')
      } finally {
        clearTimeout(timeout)
      }

      const payload = (await response.json().catch(() => null)) as ProblemBody | null

      if (!response.ok) {
        // Mesma regra da `scheduling-port`: código fora do catálogo deste processo vira
        // 502, porque `new AppError` com código desconhecido estouraria no construtor.
        const conhecido = payload?.code !== undefined && payload.code in ERROR_CATALOG

        if (response.status >= 500 || !conhecido) {
          logger.error(
            { status: response.status, paymentId, detail: payload?.detail },
            'billing-ledger-service recusou o recibo do Portal',
          )
          throw upstreamUnavailable('Não foi possível obter o recibo agora. Tente em instantes.')
        }

        const { code, detail, title: _title, status: _status, type: _type, ...extra } = payload
        throw new AppError(
          code as ErrorCode,
          typeof detail === 'string' ? detail : 'Não foi possível obter o recibo',
          undefined,
          Object.keys(extra).length > 0 ? extra : undefined,
        )
      }

      const receipt = payload as {
        number: string
        status: string
        issuedAt: string | null
        url: string | null
      }

      return {
        number: receipt.number,
        status: receipt.status,
        issuedAt: receipt.issuedAt,
        url: receipt.url,
      }
    },
  }
}

let port: LedgerPort | null = null

export function getLedgerPort(): LedgerPort {
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setLedgerPort(next: LedgerPort | null): void {
  port = next
}
