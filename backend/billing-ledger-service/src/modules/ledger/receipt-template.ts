import { PAYMENT_METHOD_LABELS, formatBRL, type PaymentMethod } from '@petshop/shared-types'
import { escapeHtml } from '../../lib/pdf.js'

/**
 * O HTML do recibo.
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
 */

export interface ReceiptAllocationLine {
  description: string
  amountCents: number
  occurredAt: Date
}

export interface ReceiptData {
  number: string
  tenantName: string
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

const AVISO_FISCAL =
  'Este documento é um recibo de pagamento e não substitui nota fiscal de serviço.'

export function renderReceiptHtml(data: ReceiptData): string {
  const linhas = data.allocations
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.description)}</td>
          <td class="data">${formatDate(item.occurredAt)}</td>
          <td class="valor">${formatBRL(item.amountCents)}</td>
        </tr>`,
    )
    .join('')

  const semAlocacao = data.allocations.length === 0

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Recibo ${escapeHtml(data.number)}</title>
<style>
  /* Sem fonte externa: o Gotenberg roda isolado e uma fonte que não carrega vira
     tempo de espera e depois um fallback qualquer. */
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 12pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; }
  h1 { font-size: 15pt; margin: 0; }
  .numero { font-size: 11pt; color: #555; text-align: right; }
  .numero strong { display: block; font-size: 14pt; color: #1a1a1a; }
  .destaque { margin: 28px 0; padding: 18px 20px; background: #f4f4f2; border-radius: 8px; }
  .destaque .rotulo { font-size: 10pt; color: #555; text-transform: uppercase;
                      letter-spacing: 0.05em; }
  .destaque .valor { font-size: 24pt; font-weight: bold; margin-top: 2px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
  dt { color: #555; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11pt; }
  th { text-align: left; font-size: 10pt; color: #555; text-transform: uppercase;
       letter-spacing: 0.04em; border-bottom: 1px solid #ddd; padding: 6px 0; }
  td { padding: 7px 0; border-bottom: 1px solid #f0f0f0; }
  td.valor, th.valor { text-align: right; }
  td.data, th.data { width: 22%; color: #555; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em;
       color: #555; margin: 28px 0 0; }
  footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid #ddd;
           font-size: 9.5pt; color: #555; }
  .aviso { font-weight: bold; color: #1a1a1a; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(data.tenantName)}</h1>
      <p style="margin:4px 0 0;color:#555;">Recibo de pagamento</p>
    </div>
    <div class="numero">
      Nº <strong>${escapeHtml(data.number)}</strong>
      ${formatDate(data.issuedAt)}
    </div>
  </header>

  <div class="destaque">
    <div class="rotulo">Recebemos de ${escapeHtml(data.tutorName)} a quantia de</div>
    <div class="valor">${formatBRL(data.amountCents)}</div>
  </div>

  <dl>
    <dt>Forma de pagamento</dt><dd>${escapeHtml(PAYMENT_METHOD_LABELS[data.method])}</dd>
    <dt>Recebido em</dt><dd>${formatDateTime(data.receivedAt)}</dd>
    <dt>Saldo após o pagamento</dt><dd>${saldoTexto(data.balanceAfterCents)}</dd>
  </dl>

  ${
    semAlocacao
      ? `<h2>Referente a</h2>
  <p style="margin-top:8px;">Crédito em conta, a ser usado nos próximos atendimentos.</p>`
      : `<h2>Referente a</h2>
  <table>
    <thead>
      <tr><th>Descrição</th><th class="data">Data</th><th class="valor">Valor quitado</th></tr>
    </thead>
    <tbody>${linhas}</tbody>
  </table>`
  }

  ${
    data.creditCents > 0
      ? `<p style="margin-top:14px;">Sobra de <strong>${formatBRL(data.creditCents)}</strong> registrada como crédito em conta.</p>`
      : ''
  }

  <footer>
    <p class="aviso">${AVISO_FISCAL}</p>
    ${data.footerText ? `<p>${escapeHtml(data.footerText)}</p>` : ''}
  </footer>
</body>
</html>`
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

function formatDate(value: Date): string {
  return value.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

function formatDateTime(value: Date): string {
  return value.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  })
}
