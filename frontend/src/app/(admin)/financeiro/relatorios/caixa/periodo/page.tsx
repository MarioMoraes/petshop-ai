import { formatBRL } from '@petshop/shared-types'
import {
  MolduraRelatorio,
  Valor,
  carregarRelatorio,
  formatDateOnly,
  portaoDoCaixa,
} from '../relatorio-caixa'

/**
 * Caixa por período: um dia por linha.
 *
 * Sangria e suprimento aparecem em colunas próprias e **fora** do recebido: são dinheiro
 * mudando de lugar, e não venda. Somá-los ao recebido faria o dia da sangria parecer um
 * dia ruim.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CaixaPorPeriodoPage({ searchParams }: PageProps) {
  const recusa = await portaoDoCaixa('Caixa por período')
  if (recusa) return recusa

  const { query, report } = await carregarRelatorio(searchParams)

  return (
    <MolduraRelatorio
      title="Caixa por período"
      basePath="/financeiro/relatorios/caixa/periodo"
      query={query}
      report={report}
      isEmpty={(r) => r.days.length === 0}
      vazio={{
        title: 'Nenhum movimento no período',
        description:
          'Não houve caixa aberto entre as datas escolhidas. Amplie o período para ver mais.',
      }}
    >
      {(r) => (
        <div className="card overflow-x-auto p-0">
          <table className="data-table min-w-[44rem]">
            <thead>
              <tr>
                <th>Dia</th>
                <th className="text-right">Lançamentos</th>
                <th className="text-right">Vendas avulsas</th>
                <th className="text-right">Pagamentos de tutor</th>
                <th className="text-right">Recebido</th>
                <th className="text-right">Sangrias</th>
                <th className="text-right">Suprimentos</th>
              </tr>
            </thead>
            <tbody>
              {r.days.map((day) => (
                <tr key={day.date}>
                  <td className="font-medium">{formatDateOnly(day.date)}</td>
                  <td className="text-right text-muted tabular-nums">{day.count}</td>
                  <Valor cents={day.walkInCents} />
                  <Valor cents={day.tutorPaymentsCents} />
                  <Valor cents={day.receivedCents} strong />
                  <Valor cents={day.withdrawalsCents} />
                  <Valor cents={day.depositsCents} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="text-right tabular-nums">{r.totals.count}</td>
                <td className="text-right tabular-nums">{formatBRL(r.totals.walkInCents)}</td>
                <td className="text-right tabular-nums">
                  {formatBRL(r.totals.tutorPaymentsCents)}
                </td>
                <td className="text-right tabular-nums">{formatBRL(r.totals.receivedCents)}</td>
                <td className="text-right tabular-nums">{formatBRL(r.totals.withdrawalsCents)}</td>
                <td className="text-right tabular-nums">{formatBRL(r.totals.depositsCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </MolduraRelatorio>
  )
}
