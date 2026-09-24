import { ApiError } from '@petshop/api-client'
import {
  AGING_BUCKET_LABELS,
  formatBRL,
  type AccountsReceivableReport,
} from '@petshop/shared-types'
import { AlertTriangleIcon, ReceiptIcon } from '@/components/icons'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { BackToCobranca, ReportFilters } from '../report-filters'

/**
 * Relatório de contas a receber.
 *
 * A tela mostra o mesmo objeto que o PDF imprime — é o mesmo endpoint, em duas formas.
 * Ver antes de imprimir importa aqui mais do que na maioria das telas: o recorte tem
 * duas alavancas (a data-base e o atraso mínimo), e gerar papel para descobrir que o
 * filtro estava errado é o desperdício que esta página existe para evitar.
 *
 * "Em aberto" é o **débito** não quitado, não o saldo da conta. Quem deve R$ 100 e tem
 * R$ 30 de crédito à espera aparece com R$ 100 — é o que se cobra; o crédito o próximo
 * pagamento consome sozinho (RN-07).
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** As opções do corte por atraso. Zero é "tudo em aberto", inclusive o de hoje. */
const ATRASOS = [
  { value: 0, label: 'Tudo em aberto' },
  { value: 1, label: 'Vencidos' },
  { value: 30, label: 'Mais de 30 dias' },
  { value: 60, label: 'Mais de 60 dias' },
] as const

export default async function ContasAReceberPage({ searchParams }: PageProps) {
  const params = await searchParams
  const asOf = asDate(params.asOf)
  const minOverdueDays = asAtraso(params.minOverdueDays)

  const query = {
    ...(asOf ? { asOf } : {}),
    ...(minOverdueDays > 0 ? { minOverdueDays } : {}),
  }

  const report = await serverApi()
    .getAccountsReceivableReport(query)
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  )
  const pdfHref = `/cobranca/pdf/contas-a-receber${search.size > 0 ? `?${search}` : ''}`

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cobrança"
        title="Contas a receber"
        subtitle={
          report instanceof ApiError
            ? 'O financeiro não respondeu'
            : `${formatBRL(report.totalCents)} em aberto, de ${report.tutorsCount} ${
                report.tutorsCount === 1 ? 'tutor' : 'tutores'
              }`
        }
        actions={<BackToCobranca />}
      />

      <ReportFilters basePath="/cobranca/contas-a-receber" pdfHref={pdfHref}>
        <label className="block">
          <span className="hint">Posição em</span>
          <input
            type="date"
            name="asOf"
            className="field mt-1"
            defaultValue={report instanceof ApiError ? asOf : report.asOf}
          />
        </label>
        <label className="block">
          <span className="hint">Atraso</span>
          <select
            name="minOverdueDays"
            className="field mt-1"
            defaultValue={String(minOverdueDays)}
          >
            {ATRASOS.map((opcao) => (
              <option key={opcao.value} value={opcao.value}>
                {opcao.label}
              </option>
            ))}
          </select>
        </label>
      </ReportFilters>

      {report instanceof ApiError ? (
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="O financeiro não respondeu"
          description={report.message}
        />
      ) : report.rows.length === 0 ? (
        <EmptyState
          icon={<ReceiptIcon />}
          tone="icon-money"
          title="Nada em aberto"
          description={
            minOverdueDays > 0
              ? 'Nenhum tutor com débito nessa faixa de atraso. Tente ampliar o filtro.'
              : 'Nenhum débito em aberto nesta data. Todas as contas estão quitadas.'
          }
        />
      ) : (
        <>
          <Buckets report={report} />
          {report.truncated && (
            <div className="card border-danger/40 bg-danger-soft/60 px-5 py-4">
              <p className="text-sm font-semibold text-danger">A lista foi cortada</p>
              <p className="hint mt-1">
                Só cabem {report.rows.length} tutores por relatório, e estes são os de dívida mais
                antiga. Os totais somam apenas o que está listado — há mais contas em aberto.
                Estreite pelo atraso para ver o resto.
              </p>
            </div>
          )}
          <Tabela report={report} />
        </>
      )}
    </div>
  )
}

/** As três faixas e o total. É o que se olha antes de descer para a lista. */
function Buckets({ report }: { report: AccountsReceivableReport }) {
  const tiles = [
    { label: AGING_BUCKET_LABELS['0_30d'], value: report.buckets['0_30d'], tone: '' },
    { label: AGING_BUCKET_LABELS['30_60d'], value: report.buckets['30_60d'], tone: '' },
    {
      // Mais de 60 dias em vermelho: é a faixa que já não se resolve com um lembrete.
      label: AGING_BUCKET_LABELS['60d_plus'],
      value: report.buckets['60d_plus'],
      tone: report.buckets['60d_plus'] > 0 ? 'text-danger' : '',
    },
    { label: 'Total em aberto', value: report.totalCents, tone: '' },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <p className="hint">{tile.label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${tile.tone}`}>
            {formatBRL(tile.value)}
          </p>
        </Card>
      ))}
    </div>
  )
}

/**
 * A lista.
 *
 * Tabela de verdade, e não linhas em `div`: são sete colunas de número que precisam
 * alinhar entre si para serem comparáveis de relance, e é exatamente para isso que
 * `<table>` existe. As telas de lista do sistema usam `div` porque cada linha ali é um
 * registro com forma própria; aqui cada linha é a mesma grade.
 *
 * Rola dentro do próprio cartão: numa tela estreita, deixar a página inteira rolar de
 * lado levaria o menu junto.
 */
function Tabela({ report }: { report: AccountsReceivableReport }) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="data-table min-w-[52rem]">
        <thead>
          <tr>
            <th>Tutor</th>
            <th>Telefone</th>
            <th className="text-right">Mais antigo</th>
            <th className="text-right">Dias</th>
            <th className="text-right">{AGING_BUCKET_LABELS['0_30d']}</th>
            <th className="text-right">{AGING_BUCKET_LABELS['30_60d']}</th>
            <th className="text-right">{AGING_BUCKET_LABELS['60d_plus']}</th>
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.tutorId}>
              <td className="font-medium">{row.tutorName}</td>
              <td className="text-muted tabular-nums">
                {row.phone ? formatPhone(row.phone) : '—'}
              </td>
              <td className="text-right text-muted tabular-nums">{formatDate(row.oldestDueAt)}</td>
              <td
                className={`text-right tabular-nums ${
                  row.overdueDays >= 60 ? 'font-medium text-danger' : 'text-muted'
                }`}
              >
                {row.overdueDays}
              </td>
              <Valor cents={row.buckets['0_30d']} />
              <Valor cents={row.buckets['30_60d']} />
              <Valor cents={row.buckets['60d_plus']} />
              <td className="text-right font-medium tabular-nums">{formatBRL(row.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Célula de valor. Zero vira travessão, não "R$ 0,00".
 *
 * Escrever o zero em toda faixa vazia faz a coluna que **tem** número desaparecer no
 * meio das que não têm — e é justamente por essa comparação que a tabela existe.
 */
function Valor({ cents }: { cents: number }) {
  return cents === 0 ? (
    <td className="text-right text-subtle">—</td>
  ) : (
    <td className="text-right tabular-nums">{formatBRL(cents)}</td>
  )
}

/** `+5511987654321` → `(11) 98765-4321`. Quem vai discar lê melhor assim. */
function formatPhone(e164: string): string {
  const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164
}

function formatDate(isoDateTime: string): string {
  return new Date(isoDateTime).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

function asDate(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}

/** Só os cortes que a tela oferece. Um `?minOverdueDays=7` digitado à mão cai em zero. */
function asAtraso(value: string | string[] | undefined): number {
  const raw = Number(Array.isArray(value) ? value[0] : value)
  return ATRASOS.some((opcao) => opcao.value === raw) ? raw : 0
}
