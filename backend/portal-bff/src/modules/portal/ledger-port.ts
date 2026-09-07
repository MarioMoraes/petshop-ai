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

/** Um documento que desce em bytes, porque não existe arquivo a assinar. */
export interface LedgerDownload {
  bytes: Buffer
  filename: string
}

export interface LedgerPort {
  receipt(caller: LedgerCaller, paymentId: string): Promise<PortalReceiptResponse>
  /**
   * O extrato em papel (AC-02 de MOD-DOC-09).
   *
   * Bytes, e não URL assinada, porque o extrato **não é arquivado** (AC-04): não há
   * objeto no bucket cujo endereço se pudesse assinar. É a mesma razão pela qual a
   * exportação de dados do MOD-PORTAL-09 também desce em bytes.
   *
   * A folha é montada pelo ledger, que é quem sabe somar dinheiro. Refazer a soma aqui
   * criaria um extrato que pode discordar do que a tela mostrou — em dinheiro, com o
   * tutor segurando o papel.
   */
  statementPdf(caller: LedgerCaller, tutorId: string): Promise<LedgerDownload>
}

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Teto do documento montado na hora.
 *
 * Vinte e cinco segundos, e não os quinze das outras chamadas: quem monta a folha é o
 * Gotenberg, e um Chromium **frio** leva mais de doze segundos para a primeira página do
 * dia. Com o teto curto, o primeiro tutor a pedir o extrato pela manhã recebia 502 — e o
 * segundo, que pegava o navegador quente, recebia o PDF. Fica abaixo do teto de trinta
 * segundos do cliente do Next, para que a falha tenha a mensagem daqui, e não um timeout
 * anônimo lá.
 */
const DOCUMENT_TIMEOUT_MS = 25_000

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

    async statementPdf(caller, tutorId) {
      const env = loadEnv()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS)

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
          `${env.BILLING_LEDGER_SERVICE_URL}/v1/ledger/accounts/${tutorId}/statement/pdf`,
          { method: 'GET', headers, signal: controller.signal },
        )
      } catch (error) {
        logger.error({ err: error, tutorId }, 'falha ao pedir o extrato em PDF ao ledger')
        throw upstreamUnavailable('Não foi possível gerar o extrato agora. Tente em instantes.')
      } finally {
        clearTimeout(timeout)
      }

      if (!response.ok) {
        const problema = (await response.json().catch(() => null)) as ProblemBody | null
        const conhecido = problema?.code !== undefined && problema.code in ERROR_CATALOG

        if (response.status >= 500 || !conhecido) {
          logger.error(
            { status: response.status, tutorId, detail: problema?.detail },
            'billing-ledger-service recusou o extrato do Portal',
          )
          throw upstreamUnavailable('Não foi possível gerar o extrato agora. Tente em instantes.')
        }

        throw new AppError(
          problema?.code as ErrorCode,
          typeof problema?.detail === 'string' ? problema.detail : 'Não foi possível gerar o extrato',
        )
      }

      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        // O nome vem de quem montou a folha: é ele que sabe o período impresso nela.
        filename: filenameFrom(response.headers.get('content-disposition')),
      }
    },
  }
}

/** `attachment; filename="extrato-2026-09-07.pdf"` → o nome, ou um padrão. */
function filenameFrom(header: string | null): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null
  return match?.[1] ?? `extrato-${new Date().toISOString().slice(0, 10)}.pdf`
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
