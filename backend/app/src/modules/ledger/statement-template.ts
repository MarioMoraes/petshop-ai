import { renderDocument, type DocumentIssuer } from '@petshop/documents'
import {
  ENTRY_CATEGORY_LABELS,
  formatBRL,
  portalCreditCents,
  portalOwesCents,
  type EntryCategory,
} from '@petshop/shared-types'
import { escapeHtml } from './pdf-port.js'

/**
 * O extrato da conta do tutor, em papel (MOD-DOC-09).
 *
 * **Não é documento arquivado, e é de propósito** (RN-01 e AC-04): nenhuma linha entra
 * em `documents`, nenhum objeto vai ao bucket, e por isso ele também não tem número de
 * série. O extrato descreve o presente — guardá-lo produziria um arquivo que contradiz o
 * sistema no dia seguinte. É o mesmo raciocínio dos dois relatórios do MOD-COBRANCA.
 *
 * O que ele **não** é: os relatórios são papel de trabalho do balcão, densos, com molde
 * próprio. Este vai para a mão do tutor, como o recibo, e por isso usa o molde comum de
 * `@petshop/documents` — o cabeçalho de quem emitiu é o que dá a ele valor de
 * comprovante de conta.
 *
 * **Endereço incompleto não impede a emissão**, ao contrário do recibo e do receituário
 * (AC-02 de MOD-DOC-01). Aqueles são documentos com valor legal e retenção de cinco
 * anos; este é uma consulta impressa. Recusar o extrato de quem quer conferir a própria
 * conta porque o petshop não preencheu o CEP seria punir o tutor por um cadastro que não
 * é dele — o cabeçalho sai com o que houver.
 *
 * **O sinal do saldo é a armadilha desta folha.** Negativo é dívida (RN-02 do
 * MOD-LEDGER), e o Portal já leu ao contrário uma vez. `portalOwesCents` e
 * `portalCreditCents` fazem a conversão em um lugar só, e é por elas que o texto decide
 * entre "em aberto" e "crédito".
 */

export interface StatementLine {
  occurredAt: Date
  description: string
  category: EntryCategory
  /** Positivo é crédito, negativo é débito — como o banco grava (`signed_amount_cents`). */
  signedAmountCents: number
  balanceAfterCents: number
  status: 'POSTED' | 'REVERSED'
}

export interface StatementDocumentData {
  issuer: DocumentIssuer
  timezone: string
  tutorName: string
  /** Rótulo do intervalo, já escrito: "01/08/2026 a 31/08/2026" ou "todo o histórico". */
  periodLabel: string
  openingBalanceCents: number
  closingBalanceCents: number
  totalDebitsCents: number
  totalCreditsCents: number
  lines: StatementLine[]
  /** Quantas linhas o período tem de verdade, quando a folha não coube inteira. */
  totalLines: number
  issuedAt: Date
}

export const STATEMENT_TITLE = 'Extrato da conta'

const AVISO =
  'Este extrato reflete a posição da conta no momento da emissão e não substitui recibo ' +
  'de pagamento nem nota fiscal de serviço.'

/** "Em aberto" ou "crédito", nunca o sinal cru — quem lê a folha não é contador. */
function saldoEmPalavras(cents: number): string {
  const deve = portalOwesCents(cents)
  if (deve > 0) return `${formatBRL(deve)} em aberto`

  const credito = portalCreditCents(cents)
  return credito > 0 ? `${formatBRL(credito)} de crédito` : formatBRL(0)
}

function data(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: timezone }).format(value)
}

export function renderStatementHtml(input: StatementDocumentData): string {
  const linhas = input.lines
    .map((linha) => {
      const estornado = linha.status === 'REVERSED'
      const valor = formatBRL(Math.abs(linha.signedAmountCents))

      return `
        <tr class="${estornado ? 'estornado' : ''}">
          <td class="dia">${escapeHtml(data(linha.occurredAt, input.timezone))}</td>
          <td>
            <div>${escapeHtml(linha.description)}</div>
            <div class="categoria">${escapeHtml(ENTRY_CATEGORY_LABELS[linha.category])}${
              estornado ? ' · estornado' : ''
            }</div>
          </td>
          <td class="valor ${linha.signedAmountCents < 0 ? 'debito' : 'credito'}">${
            linha.signedAmountCents < 0 ? `- ${valor}` : `+ ${valor}`
          }</td>
          <td class="valor saldo">${escapeHtml(formatBRL(Math.abs(linha.balanceAfterCents)))}${
            linha.balanceAfterCents < 0 ? ' D' : ''
          }</td>
        </tr>`
    })
    .join('')

  /**
   * AC-03 — período sem movimento sai assim mesmo.
   *
   * Um extrato vazio é resposta; um 404 é o tutor achando que o sistema perdeu os dados
   * dele. Os dois saldos aparecem iguais, que é exatamente o que aconteceu no período.
   */
  const corpo =
    input.lines.length > 0
      ? `<table>
           <thead>
             <tr>
               <th class="dia">Data</th>
               <th>Lançamento</th>
               <th class="valor">Valor</th>
               <th class="valor">Saldo</th>
             </tr>
           </thead>
           <tbody>${linhas}</tbody>
         </table>`
      : '<p class="vazio">Sem movimento no período.</p>'

  const truncado =
    input.totalLines > input.lines.length
      ? `<p class="nota">Exibindo os ${input.lines.length} lançamentos mais recentes de ${input.totalLines} no período. Para ver o restante, peça o extrato de um intervalo menor.</p>`
      : ''

  const bodyHtml = `
  <style>
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; }
    dt { color: #6b6d76; }
    dd { margin: 0; }
    h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
         color: #6b6d76; margin: 22px 0 4px; }
    td.dia, th.dia { white-space: nowrap; width: 1%; color: #6b6d76; }
    td.saldo, th.saldo { color: #6b6d76; }
    .categoria { color: #6b6d76; font-size: 9px; }
    .debito { color: #232427; }
    .credito { color: #1f7a4d; }
    .estornado td { color: #9a9ba1; text-decoration: line-through; }
    .estornado .categoria { text-decoration: none; }
    .resumo { display: flex; gap: 10px; margin-top: 18px; }
    .resumo div { flex: 1; background: #f6f7f9; border-radius: 6px; padding: 9px 11px; }
    .resumo .rotulo { font-size: 9px; color: #6b6d76; text-transform: uppercase;
                      letter-spacing: .05em; }
    .resumo .numero { font-size: 13px; font-weight: 600; margin-top: 2px; }
    .vazio { margin-top: 18px; padding: 22px; background: #f6f7f9; border-radius: 6px;
             text-align: center; color: #6b6d76; }
    .nota { margin-top: 10px; font-size: 9px; color: #6b6d76; }
    .fechamento { margin-top: 18px; border-top: 2px solid #232427; padding-top: 8px;
                  display: flex; justify-content: space-between; font-weight: 600; }
    /* O cabeçalho da tabela se repete a cada página, e nenhuma linha é partida ao meio. */
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  </style>

  <dl>
    <dt>Titular</dt><dd>${escapeHtml(input.tutorName)}</dd>
    <dt>Período</dt><dd>${escapeHtml(input.periodLabel)}</dd>
  </dl>

  <div class="resumo">
    <div>
      <div class="rotulo">Saldo de abertura</div>
      <div class="numero">${escapeHtml(saldoEmPalavras(input.openingBalanceCents))}</div>
    </div>
    <div>
      <div class="rotulo">Débitos no período</div>
      <div class="numero">${escapeHtml(formatBRL(input.totalDebitsCents))}</div>
    </div>
    <div>
      <div class="rotulo">Créditos no período</div>
      <div class="numero">${escapeHtml(formatBRL(input.totalCreditsCents))}</div>
    </div>
  </div>

  <h2>Movimento</h2>
  ${corpo}
  ${truncado}

  <div class="fechamento">
    <span>Saldo de fechamento</span>
    <span>${escapeHtml(saldoEmPalavras(input.closingBalanceCents))}</span>
  </div>`

  return renderDocument({
    issuer: input.issuer,
    title: STATEMENT_TITLE,
    // Sem número: o extrato não entra em `documents` e não tem série (AC-04).
    number: null,
    issuedAt: input.issuedAt,
    timezone: input.timezone,
    bodyHtml,
    notice: AVISO,
  })
}
