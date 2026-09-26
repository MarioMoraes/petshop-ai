import { CASH_METHOD_LABELS, formatBRL } from '@petshop/shared-types'
import { MolduraRelatorio, Valor, carregarRelatorio, portaoDoCaixa } from '../relatorio-caixa'

/**
 * Caixa por tipo de pagamento: uma forma por linha, só as que o período usou.
 *
 * A participação é sobre o recebido, e é ela que responde "quanto do meu balcão já é
 * PIX" — a pergunta que traz alguém a esta tela além da conferência com a maquininha.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CaixaPorFormaPage({ searchParams }: PageProps) {
  const recusa = await portaoDoCaixa('Caixa por tipo de pagamento')
  if (recusa) return recusa

  const { query, report } = await carregarRelatorio(searchParams)

  return (
    <MolduraRelatorio
      title="Caixa por tipo de pagamento"
      basePath="/financeiro/relatorios/caixa/forma-de-pagamento"
      query={query}
      report={report}
      isEmpty={(r) => r.byMethod.length === 0}
      vazio={{
        title: 'Nenhum recebimento no período',
        description:
          'Não houve venda avulsa nem pagamento de tutor no caixa entre as datas escolhidas.',
      }}
    >
      {(r) => (
        <div className="card overflow-x-auto p-0">
          <table className="data-table min-w-[40rem]">
            <thead>
              <tr>
                <th>Forma de pagamento</th>
                <th className="text-right">Lançamentos</th>
                <th className="text-right">Vendas avulsas</th>
                <th className="text-right">Pagamentos de tutor</th>
                <th className="text-right">Total</th>
                <th className="text-right">Participação</th>
              </tr>
            </thead>
            <tbody>
              {r.byMethod.map((row) => (
                <tr key={row.method}>
                  <td className="font-medium">{CASH_METHOD_LABELS[row.method]}</td>
                  <td className="text-right text-muted tabular-nums">{row.count}</td>
                  <Valor cents={row.walkInCents} />
                  <Valor cents={row.tutorPaymentsCents} />
                  <Valor cents={row.receivedCents} strong />
                  <td className="text-right text-muted tabular-nums">
                    {participacao(row.receivedCents, r.totals.receivedCents)}
                  </td>
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
                <td className="text-right tabular-nums">100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </MolduraRelatorio>
  )
}

function participacao(cents: number, total: number): string {
  if (total <= 0) return '—'
  return `${((cents / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}
