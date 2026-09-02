import { ApiError } from '@petshop/api-client'
import {
  PAYMENT_METHOD_LABELS,
  formatBRL,
  type PaymentMethod,
  type ReceiptsByDayReport,
} from '@petshop/shared-types'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { BackToCobranca, ReportFilters } from '../report-filters'

/**
 * Relatório de contas recebidas por dia.
 *
 * O período vem vazio por padrão e o serviço resolve para o **mês corrente até hoje**,
 * no fuso do estabelecimento — o recorte de quem abre a tela para fechar o caixa. A
 * decisão mora lá, e não aqui, porque quem sabe que dia é hoje para este petshop é quem
 * tem o `timezone` dele.
 *
 * As formas de pagamento viram **colunas**, e só as que o período usou. É assim que se
 * confere caixa: dinheiro de um lado, maquininha e PIX do outro. Reservar coluna para as
 * sete formas encheria a tela de travessões.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function RecebidasPorDiaPage({ searchParams }: PageProps) {
  const params = await searchParams
  const query = {
    ...(asDate(params.from) ? { from: asDate(params.from) as string } : {}),
    ...(asDate(params.to) ? { to: asDate(params.to) as string } : {}),
  }

  const report = await serverApi()
    .getReceiptsByDayReport(query)
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  // O PDF recebe o período **resolvido**, não o que veio na URL: sem isso, o link do
  // filtro vazio imprimiria o mês corrente no dia em que fosse clicado, e não o que
  // está na tela de quem clicou.
  const search =
    report instanceof ApiError
      ? new URLSearchParams(query)
      : new URLSearchParams({ from: report.from, to: report.to })
  const pdfHref = `/cobranca/pdf/recebidas-por-dia?${search}`

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cobrança"
        title="Contas recebidas por dia"
        subtitle={
          report instanceof ApiError
            ? 'O financeiro não respondeu'
            : `${formatBRL(report.totalCents)} em ${report.paymentsCount} ${
                report.paymentsCount === 1 ? 'pagamento' : 'pagamentos'
              }`
        }
        actions={<BackToCobranca />}
      />

      <ReportFilters basePath="/cobranca/recebidas-por-dia" pdfHref={pdfHref}>
        <label className="block">
          <span className="hint">De</span>
          <input
            type="date"
            name="from"
            className="field mt-1"
            defaultValue={report instanceof ApiError ? query.from : report.from}
          />
        </label>
        <label className="block">
          <span className="hint">Até</span>
          <input
            type="date"
            name="to"
            className="field mt-1"
            defaultValue={report instanceof ApiError ? query.to : report.to}
          />
        </label>
      </ReportFilters>

      {report instanceof ApiError ? (
        <EmptyState title="O financeiro não respondeu" description={report.message} />
      ) : report.days.length === 0 ? (
        <EmptyState
          title="Nenhum pagamento no período"
          description="Não há entradas registradas entre as datas escolhidas. Amplie o período para ver mais."
        />
      ) : (
        <>
          <Resumo report={report} />
          <Tabela report={report} />
        </>
      )}
    </div>
  )
}

/** O fechamento do período: o total, e o total de cada forma de pagamento. */
function Resumo({ report }: { report: ReceiptsByDayReport }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="hint">Total recebido</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatBRL(report.totalCents)}</p>
        </Card>
        <Card>
          <p className="hint">Pagamentos</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{report.paymentsCount}</p>
        </Card>
        <Card>
          <p className="hint">Dias com movimento</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{report.days.length}</p>
        </Card>
      </div>

      <Card>
        <p className="text-sm font-medium">Por forma de pagamento</p>
        <ul className="mt-3 space-y-2">
          {report.byMethod.map((item) => (
            <li key={item.method} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted">
                {PAYMENT_METHOD_LABELS[item.method]}
                <span className="hint ml-2">
                  {item.count} {item.count === 1 ? 'pagamento' : 'pagamentos'}
                </span>
              </span>
              <span className="font-medium tabular-nums">{formatBRL(item.totalCents)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function Tabela({ report }: { report: ReceiptsByDayReport }) {
  const methods: PaymentMethod[] = report.byMethod.map((item) => item.method)

  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="hint px-4 py-3 text-left font-medium">Dia</th>
            <th className="hint px-4 py-3 text-right font-medium">Pagtos</th>
            {methods.map((method) => (
              <th key={method} className="hint px-4 py-3 text-right font-medium">
                {PAYMENT_METHOD_LABELS[method]}
              </th>
            ))}
            <th className="hint px-4 py-3 text-right font-medium">Total do dia</th>
          </tr>
        </thead>
        <tbody>
          {report.days.map((day) => {
            const porMetodo = new Map(day.byMethod.map((item) => [item.method, item.totalCents]))
            return (
              <tr key={day.date} className="border-b border-line">
                <td className="px-4 py-3 font-medium">{formatDateOnly(day.date)}</td>
                <td className="px-4 py-3 text-right text-muted tabular-nums">{day.count}</td>
                {methods.map((method) => {
                  const cents = porMetodo.get(method) ?? 0
                  return cents === 0 ? (
                    <td key={method} className="px-4 py-3 text-right text-subtle">
                      —
                    </td>
                  ) : (
                    <td key={method} className="px-4 py-3 text-right tabular-nums">
                      {formatBRL(cents)}
                    </td>
                  )
                })}
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {formatBRL(day.totalCents)}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-ink font-semibold">
            <td className="px-4 py-3">Total</td>
            <td className="px-4 py-3 text-right tabular-nums">{report.paymentsCount}</td>
            {report.byMethod.map((item) => (
              <td key={item.method} className="px-4 py-3 text-right tabular-nums">
                {formatBRL(item.totalCents)}
              </td>
            ))}
            <td className="px-4 py-3 text-right tabular-nums">{formatBRL(report.totalCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function formatDateOnly(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year}`
}

function asDate(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}
