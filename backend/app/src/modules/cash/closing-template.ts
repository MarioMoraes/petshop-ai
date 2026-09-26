import {
  CASH_METHOD_LABELS,
  formatBRL,
  type CashMethodTotal,
  type CashMovementResponse,
  type CashSessionDetail,
} from '@petshop/shared-types'
import { escapeHtml } from './pdf-port.js'

/**
 * O fechamento do caixa impresso.
 *
 * A mesma escola de `inventory/position-template.ts`: função pura, sem engine de
 * template, e **todo campo livre passa por `escapeHtml`** — o motivo da sangria, a
 * justificativa da diferença e o nome do tutor são digitados, e o Gotenberg roda um
 * Chromium de verdade.
 *
 * É a folha que vai para a pasta junto com o dinheiro do cofre: por isso a contagem
 * vem antes dos movimentos, a diferença diz "falta" ou "sobra" em vez de um sinal, e o
 * pé tem as linhas de assinatura. Os movimentos vêm na ordem em que aconteceram, e não
 * na da tela (o mais novo primeiro): no papel se confere de cima para baixo.
 *
 * O caixa ainda aberto também imprime, como parcial — é a conferência do meio do dia —,
 * e a folha diz isso no título para não passar por fechamento.
 */

export interface ClosingReport {
  session: CashSessionDetail
  tenantName: string
  timeZone: string
  generatedAt: Date
}

export function renderClosingHtml(report: ClosingReport): string {
  const { session, timeZone } = report
  const closed = session.status === 'CLOSED'
  const titulo = closed ? 'Fechamento do caixa' : 'Caixa em aberto — conferência parcial'

  const periodo = [
    `Aberto em ${formatDateTime(session.openedAt, timeZone)}${porQuem(session.openedByName)}`,
    closed && session.closedAt
      ? `Fechado em ${formatDateTime(session.closedAt, timeZone)}${porQuem(session.closedByName)}`
      : null,
  ].filter((linha): linha is string => linha !== null)

  const diferenca = session.differenceCents === null ? '—' : differenceText(session.differenceCents)

  const justificativa = session.closingNotes
    ? `<p class="nota"><strong>Justificativa da diferença:</strong> ${escapeHtml(session.closingNotes)}</p>`
    : ''

  const movimentos = [...session.movements].reverse()

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(titulo)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  h1 { font-size: 14pt; margin: 0; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.05em; color: #555;
       margin: 22px 0 0; }
  header .sub { margin: 3px 0 0; color: #555; font-size: 10pt; }
  header .periodo { text-align: right; color: #555; }
  header .periodo strong { display: block; color: #1a1a1a; font-size: 11pt; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 8px; }
  th { text-align: left; font-size: 8.5pt; color: #555; text-transform: uppercase;
       letter-spacing: 0.04em; border-bottom: 1px solid #ddd; padding: 5px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.valor, th.valor { text-align: right; white-space: nowrap; width: 1%; }
  td.hora { white-space: nowrap; width: 1%; color: #555; }
  td.quem { color: #555; white-space: nowrap; width: 1%; }
  td.falta { color: #b91c1c; font-weight: bold; }
  td.sobra { color: #b45309; font-weight: bold; }
  td.vazio-valor { color: #bbb; }
  tfoot td { border-top: 2px solid #1a1a1a; border-bottom: none; font-weight: bold;
             padding-top: 7px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }

  .resumo { display: flex; gap: 10px; margin-top: 14px; }
  .resumo div { flex: 1; background: #f4f4f2; border-radius: 6px; padding: 9px 11px; }
  .resumo .rotulo { font-size: 8pt; color: #555; text-transform: uppercase;
                    letter-spacing: 0.05em; }
  .resumo .valor { font-size: 13pt; font-weight: bold; margin-top: 2px; }

  .nota { margin-top: 10px; padding: 9px 11px; border-left: 3px solid #b45309;
          background: #fdf6ec; color: #7c4a03; font-size: 9pt; }
  .vazio { margin-top: 8px; padding: 16px; background: #f4f4f2; border-radius: 6px;
           text-align: center; color: #555; }

  .assinaturas { display: flex; gap: 40px; margin-top: 48px; page-break-inside: avoid; }
  .assinaturas div { flex: 1; border-top: 1px solid #1a1a1a; padding-top: 5px;
                     font-size: 8.5pt; color: #555; }

  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #ddd;
           font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(report.tenantName)}</h1>
      <p class="sub">${escapeHtml(titulo)}</p>
    </div>
    <div class="periodo">
      <strong>${formatDay(session.openedAt, timeZone)}</strong>
      ${periodo.map(escapeHtml).join('<br>')}
    </div>
  </header>

  <div class="resumo">
    <div>
      <div class="rotulo">Troco inicial</div>
      <div class="valor">${formatBRL(session.openingFloatCents)}</div>
    </div>
    <div>
      <div class="rotulo">Recebido</div>
      <div class="valor">${formatBRL(session.receivedCents)}</div>
    </div>
    <div>
      <div class="rotulo">Diferença</div>
      <div class="valor">${diferenca}</div>
    </div>
  </div>

  <h2>Contagem por forma de pagamento</h2>
  <table>
    <thead>
      <tr>
        <th>Forma</th>
        <th class="valor">Esperado</th>
        <th class="valor">Contado</th>
        <th class="valor">Diferença</th>
      </tr>
    </thead>
    <tbody>${session.byMethod.map(methodRow).join('')}</tbody>
  </table>
  ${justificativa}

  <h2>Movimentos</h2>
  ${
    movimentos.length === 0
      ? '<div class="vazio">Nenhum movimento neste caixa.</div>'
      : `<table>
    <thead>
      <tr>
        <th>Hora</th>
        <th>Movimento</th>
        <th>Forma</th>
        <th>Quem</th>
        <th class="valor">Valor</th>
      </tr>
    </thead>
    <tbody>${movimentos.map((row) => movementRow(row, timeZone)).join('')}</tbody>
  </table>`
  }

  <div class="assinaturas">
    <div>Operador do caixa</div>
    <div>Conferido por</div>
  </div>

  <footer>
    Documento gerado pelo PetShop AI para uso interno em
    ${escapeHtml(formatDateTime(report.generatedAt.toISOString(), timeZone))}. O esperado é
    a soma dos movimentos de cada forma; a diferença só considera as formas contadas.
  </footer>
</body>
</html>`
}

function methodRow(row: CashMethodTotal): string {
  // Forma não conferida fica sem contagem e fora da diferença — a mesma regra do
  // fechamento, que não a dá como conferida.
  const conferida = row.countedCents !== null
  const delta = conferida ? row.countedCents! - row.expectedCents : null
  return `
      <tr>
        <td>${escapeHtml(CASH_METHOD_LABELS[row.method])}</td>
        <td class="valor">${formatBRL(row.expectedCents)}</td>
        <td class="valor${conferida ? '' : ' vazio-valor'}">${
          conferida ? formatBRL(row.countedCents!) : 'não conferido'
        }</td>
        <td class="valor${deltaClass(delta)}">${delta === null ? '—' : differenceText(delta)}</td>
      </tr>`
}

function movementRow(row: CashMovementResponse, timeZone: string): string {
  return `
      <tr>
        <td class="hora">${formatTime(row.occurredAt, timeZone)}</td>
        <td>${escapeHtml(row.description)}</td>
        <td>${escapeHtml(CASH_METHOD_LABELS[row.method])}</td>
        <td class="quem">${escapeHtml(row.createdByName ?? '—')}</td>
        <td class="valor">${formatBRL(row.amountCents)}</td>
      </tr>`
}

function deltaClass(delta: number | null): string {
  if (!delta) return ''
  return delta < 0 ? ' falta' : ' sobra'
}

/** "Faltam R$ 20,00" e não "-R$ 20,00": o sinal some numa fotocópia. */
function differenceText(cents: number): string {
  if (cents === 0) return formatBRL(0)
  return cents < 0 ? `Faltam ${formatBRL(-cents)}` : `Sobram ${formatBRL(cents)}`
}

function porQuem(name: string | null): string {
  return name ? ` por ${name}` : ''
}

function formatDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function formatDateTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' })
}

function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' })
}
