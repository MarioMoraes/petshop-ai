import { renderDocument, type DocumentIssuer } from '@petshop/documents'
import { PAYMENT_METHOD_LABELS, formatBRL, type PaymentMethod } from '@petshop/shared-types'
import { escapeHtml } from './pdf-port.js'

/**
 * O miolo do recibo.
 *
 * Função pura: entra dado, sai string. Nenhuma engine de template — não há nenhuma no
 * repositório, e trazer uma para imprimir um documento seria carregar uma linguagem
 * inteira (com o seu próprio escape, os seus próprios furos) para interpolar dez campos.
 *
 * **Todo campo livre passa por `escapeHtml`.** O Gotenberg roda um Chromium de verdade:
 * um tutor cadastrado como `<script>` viraria execução de código dentro dele.
 *
 * RN-20: isto é **recibo, não nota fiscal**. O aviso é obrigatório e sai do código, não
 * do `receipt_footer_text` — que é opcional e costuma vir vazio. Um petshop que ache
 * ter cumprido obrigação municipal por causa deste papel tem um problema que o sistema
 * ajudou a criar.
 *
 * O cabeçalho de quem emitiu e o rodapé com paginação **saíram daqui** na fatia 1 do
 * MOD-DOC: são iguais em todo documento e moram em `@petshop/documents`. Junto foi
 * embora o `America/Sao_Paulo` cravado, que datava o recibo no fuso errado para todo
 * tenant que não fosse de Brasília.
 */

export interface ReceiptAllocationLine {
  description: string
  amountCents: number
  occurredAt: Date
}

export interface ReceiptData {
  number: string
  issuer: DocumentIssuer
  timezone: string
  tutorName: string
  amountCents: number
  method: PaymentMethod
  receivedAt: Date
  issuedAt: Date
  /** O que este pagamento quitou. Vazio quando entrou tudo como crédito. */
  allocations: ReceiptAllocationLine[]
  /** Sobra que virou crédito em conta (RN-07). */
  creditCents: number
  /** Saldo do tutor depois deste pagamento. */
  balanceAfterCents: number
  /** Texto livre do tenant. Vem **depois** do aviso obrigatório, nunca no lugar dele. */
  footerText: string | null
}

export const RECEIPT_TITLE = 'Recibo de pagamento'

const AVISO_FISCAL =
  'Este documento é um recibo de pagamento e não substitui nota fiscal de serviço.'

export function renderReceiptHtml(data: ReceiptData): string {
  const linhas = data.allocations
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.description)}</td>
          <td class="data">${formatDate(item.occurredAt, data.timezone)}</td>
          <td class="valor">${formatBRL(item.amountCents)}</td>
        </tr>`,
    )
    .join('')

  const semAlocacao = data.allocations.length === 0

  const referente = semAlocacao
    ? `<h2>Referente a</h2>
       <p>Crédito em conta, a ser usado nos próximos atendimentos.</p>`
    : `<h2>Referente a</h2>
       <table>
         <thead>
           <tr><th>Descrição</th><th class="data">Data</th><th class="valor">Valor quitado</th></tr>
         </thead>
         <tbody>${linhas}</tbody>
       </table>`

  const sobra =
    data.creditCents > 0
      ? `<p class="sobra">Sobra de <strong>${formatBRL(
          data.creditCents,
        )}</strong> registrada como crédito em conta.</p>`
      : ''

  const rodapeDoTenant = data.footerText ? `<p>${escapeHtml(data.footerText)}</p>` : ''

  const bodyHtml = `
  <style>
    .destaque { margin: 18px 0 22px; padding: 16px 18px; background: #f4f4f2; border-radius: 8px; }
    .destaque .rotulo { font-size: 10px; color: #6b6d76; text-transform: uppercase;
                        letter-spacing: .05em; }
    .destaque .valor { font-size: 22px; font-weight: 700; margin-top: 2px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
    dt { color: #6b6d76; }
    dd { margin: 0; }
    h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
         color: #6b6d76; margin: 24px 0 4px; }
    td.data, th.data { width: 22%; color: #6b6d76; }
    .sobra { margin-top: 12px; }
  </style>

  <div class="destaque">
    <div class="rotulo">Recebemos de ${escapeHtml(data.tutorName)} a quantia de</div>
    <div class="valor">${formatBRL(data.amountCents)}</div>
  </div>

  <dl>
    <dt>Forma de pagamento</dt><dd>${escapeHtml(PAYMENT_METHOD_LABELS[data.method])}</dd>
    <dt>Recebido em</dt><dd>${formatDateTime(data.receivedAt, data.timezone)}</dd>
    <dt>Saldo após o pagamento</dt><dd>${saldoTexto(data.balanceAfterCents)}</dd>
  </dl>

  ${referente}
  ${sobra}
  ${rodapeDoTenant}`

  return renderDocument({
    issuer: data.issuer,
    title: RECEIPT_TITLE,
    number: data.number,
    issuedAt: data.issuedAt,
    timezone: data.timezone,
    bodyHtml,
    notice: AVISO_FISCAL,
  })
}

/**
 * O saldo em palavras.
 *
 * "R$ -59,90" no comprovante que o tutor leva para casa é ambíguo: quem está devendo?
 * A convenção do RN-02 é interna; o papel diz em português.
 */
function saldoTexto(balanceCents: number): string {
  if (balanceCents === 0) return 'Conta quitada'
  if (balanceCents > 0) return `${formatBRL(balanceCents)} de crédito`
  return `${formatBRL(-balanceCents)} em aberto`
}

function formatDate(value: Date, timeZone: string): string {
  return value.toLocaleDateString('pt-BR', { timeZone })
}

function formatDateTime(value: Date, timeZone: string): string {
  return value.toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' })
}
