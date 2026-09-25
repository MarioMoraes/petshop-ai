import {
  NO_BATCH_CODE,
  PRODUCT_KIND_LABELS,
  PRODUCT_UNIT_LABELS,
  formatBRL,
  type InventoryPositionReport,
  type PositionLot,
  type PositionProduct,
  type ProductUnit,
} from '@petshop/shared-types'
import { escapeHtml } from './pdf-port.js'

/**
 * O HTML da posição do estoque (MOD-ESTOQUE-11).
 *
 * A mesma escola de `ledger/report-template.ts`: função pura, sem engine de template, e
 * **todo campo livre passa por `escapeHtml`** — nome de produto, SKU e código de lote são
 * digitados, e o Gotenberg roda um Chromium de verdade.
 *
 * É papel de contagem: alguém vai percorrer a prateleira com a folha na mão. Por isso o
 * produto é a linha em negrito, os lotes vêm logo abaixo dele na ordem em que saem
 * (FEFO), e o lote vencido e o negativo são marcados na própria linha, e não num anexo.
 */

export function renderPositionHtml(report: InventoryPositionReport): string {
  const { totals } = report
  const kindLabel = report.kind ? ` · ${PRODUCT_KIND_LABELS[report.kind]}` : ''

  const avisos = [
    totals.uncostedLots > 0
      ? `${plural(totals.uncostedLots, 'lote com saldo não tem', 'lotes com saldo não têm')} custo
         de entrada e ${totals.uncostedLots === 1 ? 'ficou' : 'ficaram'} fora do valor total.`
      : null,
    totals.negativeLots > 0
      ? `${plural(totals.negativeLots, 'lote está', 'lotes estão')} com saldo negativo — saiu mais
         do que entrou — e ${totals.negativeLots === 1 ? 'ficou' : 'ficaram'} fora do valor.
         Confira a contagem e registre a entrada que falta.`
      : null,
    totals.expiredLots > 0
      ? `${plural(totals.expiredLots, 'lote está vencido', 'lotes estão vencidos')} e ainda
         ${totals.expiredLots === 1 ? 'conta' : 'contam'} no valor, até a baixa por perda.`
      : null,
  ].filter((aviso): aviso is string => aviso !== null)

  const corpo =
    report.products.length === 0
      ? `<div class="vazio">Nenhum produto com saldo${kindLabel ? ' neste tipo' : ''}.</div>`
      : `
  <div class="resumo">
    <div>
      <div class="rotulo">Produtos com saldo</div>
      <div class="valor">${totals.products}</div>
    </div>
    <div>
      <div class="rotulo">Lotes</div>
      <div class="valor">${totals.lots}</div>
    </div>
    <div>
      <div class="rotulo">Valor em estoque</div>
      <div class="valor">${formatBRL(totals.valueCents)}</div>
    </div>
  </div>

  ${avisos.map((aviso) => `<p class="aviso">${aviso}</p>`).join('')}

  <table>
    <thead>
      <tr>
        <th class="nome">Produto e lote</th>
        <th class="num">Validade</th>
        <th class="valor">Saldo</th>
        <th class="valor">Custo unitário</th>
        <th class="valor">Valor</th>
      </tr>
    </thead>
    <tbody>${report.products.map(productRows).join('')}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Total</td>
        <td class="valor">${formatBRL(totals.valueCents)}</td>
      </tr>
    </tfoot>
  </table>`

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Posição do estoque</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  h1 { font-size: 14pt; margin: 0; }
  header .sub { margin: 3px 0 0; color: #555; font-size: 10pt; }
  header .periodo { text-align: right; color: #555; }
  header .periodo strong { display: block; color: #1a1a1a; font-size: 11pt; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 18px; }
  th { text-align: left; font-size: 8.5pt; color: #555; text-transform: uppercase;
       letter-spacing: 0.04em; border-bottom: 1px solid #ddd; padding: 5px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.valor, th.valor { text-align: right; white-space: nowrap; width: 1%; }
  td.num, th.num { text-align: right; white-space: nowrap; width: 1%; color: #555; }
  td.nome, th.nome { min-width: 12rem; }
  /* O produto é a linha que se procura; o lote é o detalhe que se confere. */
  tr.produto td { font-weight: bold; border-top: 1px solid #ddd; padding-top: 7px; }
  tr.produto .meta { font-weight: normal; color: #555; font-size: 8.5pt; }
  tr.lote td { color: #444; }
  tr.lote td.nome { padding-left: 18px; }
  .marca { font-size: 8pt; font-weight: bold; text-transform: uppercase;
           letter-spacing: 0.04em; margin-left: 6px; }
  .marca.vencido { color: #b45309; }
  .marca.negativo { color: #b91c1c; }
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

  .vazio { margin-top: 22px; padding: 22px; background: #f4f4f2; border-radius: 6px;
           text-align: center; color: #555; }
  .aviso { margin-top: 10px; padding: 9px 11px; border-left: 3px solid #b45309;
           background: #fdf6ec; color: #7c4a03; font-size: 9pt; }

  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #ddd;
           font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(report.tenantName)}</h1>
      <p class="sub">Posição e valorização do estoque${escapeHtml(kindLabel)}</p>
    </div>
    <div class="periodo">
      <strong>Posição em ${formatDateOnly(report.asOf)}</strong>
      Emitido em ${escapeHtml(formatDateTime(report.generatedAt, report.timezone))}
    </div>
  </header>
  ${corpo}
  <footer>
    Documento gerado pelo PetShop AI para uso interno. O valor é o saldo de cada lote
    multiplicado pelo custo da entrada daquele lote.
  </footer>
</body>
</html>`
}

function productRows(product: PositionProduct): string {
  const meta = [PRODUCT_KIND_LABELS[product.kind], product.sku, product.active ? null : 'inativo']
    .filter(Boolean)
    .join(' · ')

  // O produto sem código de lote tem um lote só, implícito: repetir a mesma quantidade
  // numa linha "SEM-LOTE" logo abaixo seria dizer a mesma coisa duas vezes. O custo
  // dele sobe para a linha do produto.
  const implicit =
    product.lots.length === 1 && product.lots[0]?.batchCode === NO_BATCH_CODE
      ? product.lots[0]
      : null

  // Nenhum lote com valor: "R$ 0,00" diria que o produto não vale nada, e o que se sabe é
  // só que ninguém informou o custo (ou que o saldo está negativo).
  const semValor = product.lots.every((lot) => lot.valueCents === null)

  const head = `
        <tr class="produto">
          <td class="nome">${escapeHtml(product.name)}${implicit ? marca(implicit) : ''} <span class="meta">${escapeHtml(meta)}</span></td>
          <td class="num"></td>
          <td class="valor">${formatQuantity(product.quantityOnHand, product.unit)}</td>
          <td class="valor">${implicit ? formatCost(implicit.unitCostCents) : ''}</td>
          <td class="valor${semValor ? ' vazio-valor' : ''}">${semValor ? '—' : formatBRL(product.valueCents)}</td>
        </tr>`
  if (implicit) return head

  const lots = product.lots
    .map((lot) => {
      return `
        <tr class="lote">
          <td class="nome">Lote ${escapeHtml(lot.batchCode)}${marca(lot)}</td>
          <td class="num">${lot.expiresAt ? formatDateOnly(lot.expiresAt) : '—'}</td>
          <td class="valor">${formatQuantity(lot.quantityOnHand, product.unit)}</td>
          <td class="valor">${formatCost(lot.unitCostCents)}</td>
          <td class="valor${lot.valueCents === null ? ' vazio-valor' : ''}">${
            lot.valueCents === null ? '—' : formatBRL(lot.valueCents)
          }</td>
        </tr>`
    })
    .join('')

  return head + lots
}

/** O que a linha do lote precisa gritar: saldo negativo antes de vencido. */
function marca(lot: PositionLot): string {
  if (Number(lot.quantityOnHand) < 0) return '<span class="marca negativo">negativo</span>'
  if (lot.expired) return '<span class="marca vencido">vencido</span>'
  return ''
}

function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`
}

/**
 * A leitura da tela (`estoque/format.ts`), com a vírgula, mas com a unidade abreviada: a
 * coluna do papel é estreita e se repete em toda linha.
 */
function formatQuantity(quantity: string, unit: ProductUnit): string {
  const text = Number(quantity).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  if (unit === 'UN') return `${text} un.`
  if (unit === 'L') return `${text} L`
  return `${text} ${PRODUCT_UNIT_LABELS[unit]}`
}

function formatCost(cents: number | null): string {
  return cents === null ? '—' : formatBRL(cents)
}

function formatDateOnly(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year}`
}

function formatDateTime(isoDateTime: string, timeZone: string): string {
  return new Date(isoDateTime).toLocaleString('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  })
}
