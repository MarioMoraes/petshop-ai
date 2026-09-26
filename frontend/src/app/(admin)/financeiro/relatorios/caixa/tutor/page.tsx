import Link from 'next/link'
import { CASH_METHOD_LABELS, formatBRL } from '@petshop/shared-types'
import { MolduraRelatorio, carregarRelatorio, portaoDoCaixa } from '../relatorio-caixa'

/**
 * Caixa por tutor: quem pagou no balcão, do maior valor para o menor.
 *
 * Só o pagamento de tutor entra: a venda avulsa não tem dono, e é por isso que o total
 * desta tabela é o de "Pagamentos de tutor", e não o recebido do caixa. O nome leva à
 * ficha, onde está o extrato completo — aqui só aparece o que passou pela gaveta.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const DATA_HORA: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

export default async function CaixaPorTutorPage({ searchParams }: PageProps) {
  const recusa = await portaoDoCaixa('Caixa por tutor')
  if (recusa) return recusa

  const { query, report } = await carregarRelatorio(searchParams)

  return (
    <MolduraRelatorio
      title="Caixa por tutor"
      basePath="/financeiro/relatorios/caixa/tutor"
      query={query}
      report={report}
      isEmpty={(r) => r.byTutor.length === 0}
      vazio={{
        title: 'Nenhum tutor pagou no caixa',
        description:
          'Não houve pagamento de tutor com o caixa aberto entre as datas escolhidas. Amplie o período para ver mais.',
      }}
    >
      {(r) => {
        // No fuso do estabelecimento, e não no do servidor que renderiza.
        const fmt = new Intl.DateTimeFormat('pt-BR', { ...DATA_HORA, timeZone: r.timezone })
        return (
          <div className="card overflow-x-auto p-0">
            <table className="data-table min-w-[44rem]">
              <thead>
                <tr>
                  <th>Tutor</th>
                  <th className="text-right">Pagamentos</th>
                  <th>Formas</th>
                  <th>Último pagamento</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {r.byTutor.map((row) => (
                  <tr key={row.tutorId}>
                    <td className="font-medium">
                      <Link href={`/tutores/${row.tutorId}`} className="hover:underline">
                        {row.tutorName}
                      </Link>
                    </td>
                    <td className="text-right text-muted tabular-nums">{row.count}</td>
                    <td className="text-muted">
                      {row.methods.map((method) => CASH_METHOD_LABELS[method]).join(', ')}
                    </td>
                    <td className="text-muted tabular-nums">
                      {fmt.format(new Date(row.lastPaymentAt))}
                    </td>
                    <td className="text-right font-medium tabular-nums">
                      {formatBRL(row.receivedCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{r.byTutor.length === 1 ? '1 tutor' : `${r.byTutor.length} tutores`}</td>
                  <td className="text-right tabular-nums">
                    {r.byTutor.reduce((sum, row) => sum + row.count, 0)}
                  </td>
                  <td />
                  <td />
                  <td className="text-right tabular-nums">
                    {formatBRL(r.byTutor.reduce((sum, row) => sum + row.receivedCents, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      }}
    </MolduraRelatorio>
  )
}
