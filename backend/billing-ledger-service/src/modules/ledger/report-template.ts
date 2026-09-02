import {
  AGING_BUCKET_LABELS,
  PAYMENT_METHOD_LABELS,
  formatBRL,
  type AccountsReceivableReport,
  type PaymentMethod,
  type ReceiptsByDayReport,
} from '@petshop/shared-types'
import { escapeHtml } from '../../lib/pdf.js'

/**
 * O HTML dos dois relatórios do menu Cobrança.
 *
 * Mesma decisão de `receipt-template.ts`, pelas mesmas razões: função pura, sem engine
 * de template, e **todo campo livre passa por `escapeHtml`** — o Gotenberg roda um
 * Chromium de verdade, e um tutor cadastrado como `<script>` viraria execução dentro
 * dele. Nome de tutor e nome de estabelecimento são campos livres.
 *
 * O que muda em relação ao recibo é o público. O recibo é um documento que o tutor
 * leva para casa e por isso tem destaque, valor em corpo 24 e frase em português. Estes
 * dois são **papel de trabalho**: alguém vai ler linha por linha com o telefone na mão,
 * ou conferir contra o dinheiro da gaveta. A folha é densa, o alinhamento das colunas
 * de valor é o que importa, e o total fica onde o olho para — no fim.
 */

/** A folha comum: o mesmo cabeçalho, a mesma tabela, o mesmo rodapé nos dois. */
function page(options: {
  title: string
  tenantName: string
  periodLabel: string
  generatedAt: string
  body: string
}): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<style>
  /* Sem fonte externa: o Gotenberg roda isolado e uma fonte que não carrega vira
     tempo de espera e depois um fallback qualquer. */
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  h1 { font-size: 14pt; margin: 0; }
  header .sub { margin: 3px 0 0; color: #555; font-size: 10pt; }
  header .periodo { text-align: right; color: #555; }
  header .periodo strong { display: block; color: #1a1a1a; font-size: 11pt; }

  h2 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.05em;
       color: #555; margin: 22px 0 6px; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; font-size: 8.5pt; color: #555; text-transform: uppercase;
       letter-spacing: 0.04em; border-bottom: 1px solid #ddd; padding: 5px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  /* width:1% com nowrap encolhe a coluna ao conteúdo: sem isso o navegador
     reparte a largura por igual e o nome do tutor quebra em três linhas para dar
     espaço a uma coluna de valor que não precisava dele. */
  td.valor, th.valor { text-align: right; white-space: nowrap; width: 1%; }
  td.num, th.num { text-align: right; white-space: nowrap; width: 1%; color: #555; }
  td.fraco { color: #555; }
  /* O telefone também encolhe ao conteúdo: assim toda a folga sobra para o nome do
     tutor, que é a única coluna que pode legitimamente precisar de duas linhas. */
  td.tel { color: #555; white-space: nowrap; width: 1%; }
  /* Com todas as demais colunas encolhidas ao conteúdo, o layout automático ainda dá
     ao nome só a largura da palavra mais longa. O piso é o que garante que "Mário
     Moraes" caiba numa linha; nome de verdade comprido ainda quebra, e deve. */
  td.nome, th.nome { min-width: 9rem; }
  /* Zero não é valor: escrevê-lo em toda célula vazia faz a coluna que **tem** número
     desaparecer no meio dos que não têm. */
  td.zero { color: #bbb; }
  tbody tr:nth-child(even) { background: #fafafa; }
  tfoot td { border-top: 2px solid #1a1a1a; border-bottom: none; font-weight: bold;
             padding-top: 7px; }

  /* O cabeçalho da tabela se repete em cada página impressa, e nenhuma linha é
     partida ao meio pela quebra. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }

  .resumo { display: flex; gap: 10px; margin-top: 14px; }
  .resumo div { flex: 1; background: #f4f4f2; border-radius: 6px; padding: 9px 11px; }
  .resumo .rotulo { font-size: 8pt; color: #555; text-transform: uppercase;
                    letter-spacing: 0.05em; }
  .resumo .valor { font-size: 13pt; font-weight: bold; margin-top: 2px; }

  .vazio { margin-top: 22px; padding: 22px; background: #f4f4f2; border-radius: 6px;
           text-align: center; color: #555; }
  .aviso { margin-top: 12px; padding: 9px 11px; border-left: 3px solid #b45309;
           background: #fdf6ec; color: #7c4a03; font-size: 9pt; }

  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #ddd;
           font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(options.tenantName)}</h1>
      <p class="sub">${escapeHtml(options.title)}</p>
    </div>
    <div class="periodo">
      <strong>${escapeHtml(options.periodLabel)}</strong>
      Emitido em ${escapeHtml(options.generatedAt)}
    </div>
  </header>
  ${options.body}
  <footer>
    Documento gerado pelo PetShop AI para uso interno. Os valores refletem os
    lançamentos registrados até a emissão.
  </footer>
</body>
</html>`
}

/**
 * Relatório 1 — contas a receber.
 *
 * As três faixas viram três colunas, e não três blocos empilhados, porque a pergunta de
 * quem cobra é "quanto está velho?" comparando um tutor com o outro. Empilhado, a
 * comparação exigiria folhear.
 */
export function renderAccountsReceivableHtml(report: AccountsReceivableReport): string {
  const linhas = report.rows
    .map(
      (row) => `
        <tr>
          <td class="nome">${escapeHtml(row.tutorName)}</td>
          <td class="tel">${row.phone ? escapeHtml(formatPhone(row.phone)) : '—'}</td>
          <td class="num">${formatDate(row.oldestDueAt, report.timezone)}</td>
          <td class="num">${row.overdueDays}</td>
          ${bucketCell(row.buckets['0_30d'])}
          ${bucketCell(row.buckets['30_60d'])}
          ${bucketCell(row.buckets['60d_plus'])}
          <td class="valor">${formatBRL(row.totalCents)}</td>
        </tr>`,
    )
    .join('')

  const corpo =
    report.rows.length === 0
      ? `<div class="vazio">Nenhum débito em aberto${
          report.minOverdueDays > 0 ? ` com mais de ${report.minOverdueDays} dias de atraso` : ''
        }.</div>`
      : `
  <div class="resumo">
    <div>
      <div class="rotulo">${escapeHtml(AGING_BUCKET_LABELS['0_30d'])}</div>
      <div class="valor">${formatBRL(report.buckets['0_30d'])}</div>
    </div>
    <div>
      <div class="rotulo">${escapeHtml(AGING_BUCKET_LABELS['30_60d'])}</div>
      <div class="valor">${formatBRL(report.buckets['30_60d'])}</div>
    </div>
    <div>
      <div class="rotulo">${escapeHtml(AGING_BUCKET_LABELS['60d_plus'])}</div>
      <div class="valor">${formatBRL(report.buckets['60d_plus'])}</div>
    </div>
    <div>
      <div class="rotulo">Total em aberto</div>
      <div class="valor">${formatBRL(report.totalCents)}</div>
    </div>
  </div>

  ${
    report.truncated
      ? `<p class="aviso">A lista foi cortada nos ${report.rows.length} tutores com a dívida mais
         antiga. Os totais abaixo somam apenas o que está nesta folha — há mais contas em
         aberto do que as listadas.</p>`
      : ''
  }

  <h2>${report.tutorsCount} ${report.tutorsCount === 1 ? 'tutor' : 'tutores'} com débito em aberto</h2>
  <table>
    <thead>
      <tr>
        <th class="nome">Tutor</th>
        <th>Telefone</th>
        <th class="num">Vencimento mais antigo</th>
        <th class="num">Dias</th>
        <th class="valor">${escapeHtml(AGING_BUCKET_LABELS['0_30d'])}</th>
        <th class="valor">${escapeHtml(AGING_BUCKET_LABELS['30_60d'])}</th>
        <th class="valor">${escapeHtml(AGING_BUCKET_LABELS['60d_plus'])}</th>
        <th class="valor">Total</th>
      </tr>
    </thead>
    <tbody>${linhas}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Total</td>
        <td class="valor">${formatBRL(report.buckets['0_30d'])}</td>
        <td class="valor">${formatBRL(report.buckets['30_60d'])}</td>
        <td class="valor">${formatBRL(report.buckets['60d_plus'])}</td>
        <td class="valor">${formatBRL(report.totalCents)}</td>
      </tr>
    </tfoot>
  </table>`

  return page({
    title: 'Relatório de contas a receber',
    tenantName: report.tenantName,
    periodLabel: `Posição em ${formatDateOnly(report.asOf)}`,
    generatedAt: formatDateTime(report.generatedAt, report.timezone),
    body: corpo,
  })
}

/**
 * Relatório 2 — contas recebidas por dia.
 *
 * Uma linha por dia com movimento, e as formas de pagamento **como colunas**: é assim
 * que se confere o caixa — dinheiro de um lado, maquininha do outro. Só as formas que o
 * período usou viram coluna; reservar espaço para as sete deixaria a folha cheia de
 * traços.
 */
export function renderReceiptsByDayHtml(report: ReceiptsByDayReport): string {
  const methods: PaymentMethod[] = report.byMethod.map((item) => item.method)

  const linhas = report.days
    .map((day) => {
      const porMetodo = new Map(day.byMethod.map((item) => [item.method, item.totalCents]))
      return `
        <tr>
          <td>${formatDateOnly(day.date)}</td>
          <td class="num">${day.count}</td>
          ${methods.map((method) => bucketCell(porMetodo.get(method) ?? 0)).join('')}
          <td class="valor">${formatBRL(day.totalCents)}</td>
        </tr>`
    })
    .join('')

  const corpo =
    report.days.length === 0
      ? `<div class="vazio">Nenhum pagamento recebido neste período.</div>`
      : `
  <div class="resumo">
    <div>
      <div class="rotulo">Total recebido</div>
      <div class="valor">${formatBRL(report.totalCents)}</div>
    </div>
    <div>
      <div class="rotulo">Pagamentos</div>
      <div class="valor">${report.paymentsCount}</div>
    </div>
    <div>
      <div class="rotulo">Dias com movimento</div>
      <div class="valor">${report.days.length}</div>
    </div>
  </div>

  <h2>Entradas dia a dia</h2>
  <table>
    <thead>
      <tr>
        <th>Dia</th>
        <th class="num">Pagtos</th>
        ${methods
          .map((method) => `<th class="valor">${escapeHtml(PAYMENT_METHOD_LABELS[method])}</th>`)
          .join('')}
        <th class="valor">Total do dia</th>
      </tr>
    </thead>
    <tbody>${linhas}</tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td class="num">${report.paymentsCount}</td>
        ${report.byMethod
          .map((item) => `<td class="valor">${formatBRL(item.totalCents)}</td>`)
          .join('')}
        <td class="valor">${formatBRL(report.totalCents)}</td>
      </tr>
    </tfoot>
  </table>`

  return page({
    title: 'Relatório de contas recebidas por dia',
    tenantName: report.tenantName,
    periodLabel: `${formatDateOnly(report.from)} a ${formatDateOnly(report.to)}`,
    generatedAt: formatDateTime(report.generatedAt, report.timezone),
    body: corpo,
  })
}

function bucketCell(cents: number): string {
  return cents === 0
    ? '<td class="valor zero">—</td>'
    : `<td class="valor">${formatBRL(cents)}</td>`
}

/** `+5511987654321` → `(11) 98765-4321`. Quem vai discar lê melhor assim. */
function formatPhone(e164: string): string {
  const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164
}

function formatDateOnly(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year}`
}

/**
 * Data e hora **no fuso do estabelecimento**, e não num fuso fixo no código.
 *
 * O relatório já agrupa o dia pelo fuso do tenant; imprimir as datas em São Paulo faria
 * o papel discordar da própria tabela em qualquer petshop fora do Sudeste — e a
 * discordância seria de um dia, no documento em que alguém confere dinheiro.
 */
function formatDate(isoDateTime: string, timeZone: string): string {
  return new Date(isoDateTime).toLocaleDateString('pt-BR', { timeZone })
}

function formatDateTime(isoDateTime: string, timeZone: string): string {
  return new Date(isoDateTime).toLocaleString('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  })
}
