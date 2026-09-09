import type { PortalReceiptResponse } from '@petshop/shared-types'
import { documentUnavailable } from '../ledger/errors.js'
import { PdfUnavailableError, renderPdf } from '../ledger/pdf-port.js'
import { getReceiptForPayment } from '../ledger/receipts.js'
import { statementDocument, statementFilename } from '../ledger/statement.js'
import { renderStatementHtml } from '../ledger/statement-template.js'
import type { ActorContext } from '../ledger/actor.js'

/**
 * A porta para o MOD-LEDGER, e só para o documento.
 *
 * Era um salto HTTP com contexto assinado. Virou chamada de função na fatia 11, e o corte
 * continua o mesmo: **pedir o recibo não é ler**. `getReceiptForPayment` emite o PDF quando
 * ele ainda não existe — renderiza o documento no Gotenberg, grava no bucket, muda o status
 * para `ISSUED`, publica `recibo.emitido` e escreve na trilha. Refazer isso aqui seria uma
 * segunda emissora de documento contábil, com um segundo contador de tentativas.
 *
 * O resto do módulo continua lendo direto: saldo, lançamentos e pacotes são recorte, e
 * recorte é o que o Portal faz.
 *
 * **A elevação de permissão é a mesma da `scheduling-port` e tem o mesmo contorno.** O
 * papel `TUTOR` não tem `finance:read`; estas duas operações acontecem como se tivesse. O
 * que as segura:
 *
 * 1. a posse do pagamento é provada **antes** da chamada (`ownsPayment`, em `finance.ts`),
 *    com o recorte na consulta e 404 para o que não é dele;
 * 2. as operações são duas, e as duas leem. O tutor não registra pagamento, não estorna e
 *    não concede crédito a si mesmo — `finance:create`, `finance:refund` e `finance:credit`
 *    não têm por onde entrar aqui;
 * 3. o ator carrega o `userId` do tutor, e é ele que aparece na trilha.
 *
 * **O timeout do documento saiu com a rede, e o motivo dele não.** Havia aqui um teto de 25
 * segundos, mais folgado que o das outras chamadas, porque um Chromium **frio** leva mais
 * de doze segundos para a primeira página do dia — com o teto curto, o primeiro tutor a
 * pedir o extrato pela manhã recebia 502 e o segundo recebia o PDF. Sem o salto de rede não
 * há mais teto nosso no meio: quem espera o Gotenberg é `renderPdf`, e o único limite que
 * resta é o do cliente do Next, de trinta segundos.
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

/** O ator que o MOD-LEDGER recebe, montado do chamador do Portal. */
function actorOf(caller: LedgerCaller): ActorContext {
  return { tenantId: caller.tenantId, actorUserId: caller.userId }
}

function createInProcessPort(): LedgerPort {
  return {
    async receipt(caller, paymentId) {
      const receipt = await getReceiptForPayment(actorOf(caller), paymentId)
      return {
        number: receipt.number,
        status: receipt.status,
        issuedAt: receipt.issuedAt,
        url: receipt.url,
      }
    },

    async statementPdf(caller, tutorId) {
      /**
       * O período vazio, e é o que a rota do Admin recebe quando ninguém filtra: o extrato
       * do Portal é sempre o completo. `statementFilename` lê os mesmos campos, então o
       * nome do arquivo continua saindo de quem montou a folha.
       */
      const period = {}
      const data = await statementDocument(actorOf(caller), tutorId, period)

      try {
        return {
          bytes: await renderPdf(renderStatementHtml(data)),
          filename: statementFilename(period),
        }
      } catch (error) {
        // O mesmo ramo do `sendPdf` do MOD-LEDGER: Gotenberg fora do ar é 503 do catálogo
        // daquele módulo, e não um 500 nosso. Era um 502 traduzido do status HTTP.
        if (error instanceof PdfUnavailableError) throw documentUnavailable()
        throw error
      }
    },
  }
}

let port: LedgerPort | null = null

export function getLedgerPort(): LedgerPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setLedgerPort(next: LedgerPort | null): void {
  port = next
}
