import type { ReactNode } from 'react'
import { ApiError } from '@petshop/api-client'
import { formatBRL, type CashReport } from '@petshop/shared-types'
import { AlertTriangleIcon, BanknoteIcon, ShieldCheckIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { ReportFilters } from '../report-filters'

/**
 * O que os três relatórios do caixa dividem: o portão, a carga, o cabeçalho com o
 * período e os totais.
 *
 * Os três leem a **mesma** rota (`/v1/cash/reports`) e mostram recortes diferentes dela
 * — é o que garante que o total por período, por forma e por tutor sejam o mesmo número.
 */

type CaixaReportPath =
  | '/financeiro/relatorios/caixa/periodo'
  | '/financeiro/relatorios/caixa/forma-de-pagamento'
  | '/financeiro/relatorios/caixa/tutor'

type SearchParams = Record<string, string | string[] | undefined>

/**
 * O plano e a permissão, **antes** da chamada: pedir a API primeiro traria o 402 para
 * a tela. Devolve a tela de recusa, ou `null` quando pode seguir.
 */
export async function portaoDoCaixa(title: string): Promise<ReactNode | null> {
  const me = await carregarMe()
  if (!temRecurso(me, 'CASH_REGISTER')) {
    return <PlanoIndisponivel me={me} feature="CASH_REGISTER" />
  }
  if (!me.permissions.includes('cash:read')) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Financeiro" title={title} />
        <EmptyState
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          title="O caixa é do balcão"
          description="Os relatórios do caixa são da recepção e do administrador."
        />
      </div>
    )
  }
  return null
}

export async function carregarRelatorio(searchParams: Promise<SearchParams>) {
  const params = await searchParams
  const query = {
    ...(asDate(params.from) ? { from: asDate(params.from) as string } : {}),
    ...(asDate(params.to) ? { to: asDate(params.to) as string } : {}),
  }
  const report = await serverApi()
    .getCashReport(query)
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })
  return { query, report }
}

interface MolduraProps {
  title: string
  basePath: CaixaReportPath
  query: { from?: string; to?: string }
  report: CashReport | ApiError
  /** O conteúdo quando há movimento no período. */
  children: (report: CashReport) => ReactNode
  /** O que dizer quando o recorte vem vazio. */
  vazio: { title: string; description: string }
  isEmpty: (report: CashReport) => boolean
}

/** Cabeçalho, filtro de período, totais e o estado de erro ou vazio — igual nos três. */
export function MolduraRelatorio({
  title,
  basePath,
  query,
  report,
  children,
  vazio,
  isEmpty,
}: MolduraProps) {
  const falhou = report instanceof ApiError

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Relatórios do Caixa"
        title={title}
        subtitle={
          falhou
            ? 'O caixa não respondeu'
            : `${formatDateOnly(report.from)} a ${formatDateOnly(report.to)} · ${formatBRL(
                report.totals.receivedCents,
              )} recebidos no caixa`
        }
        actions={
          <ButtonLink href="/financeiro/relatorios/caixa" variant="ghost">
            Voltar
          </ButtonLink>
        }
      />

      <ReportFilters basePath={basePath}>
        <label className="block">
          <span className="hint">De</span>
          <input
            type="date"
            name="from"
            className="field mt-1"
            defaultValue={falhou ? query.from : report.from}
          />
        </label>
        <label className="block">
          <span className="hint">Até</span>
          <input
            type="date"
            name="to"
            className="field mt-1"
            defaultValue={falhou ? query.to : report.to}
          />
        </label>
      </ReportFilters>

      {falhou ? (
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="O caixa não respondeu"
          description={report.message}
        />
      ) : isEmpty(report) ? (
        <EmptyState icon={<BanknoteIcon />} tone="icon-money" {...vazio} />
      ) : (
        <>
          <Totais report={report} />
          {children(report)}
        </>
      )}
    </div>
  )
}

function Totais({ report }: { report: CashReport }) {
  const { totals } = report
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Numero label="Recebido no caixa" value={formatBRL(totals.receivedCents)} />
      <Numero label="Vendas avulsas" value={formatBRL(totals.walkInCents)} />
      <Numero label="Pagamentos de tutor" value={formatBRL(totals.tutorPaymentsCents)} />
      <Numero label="Caixas abertos" value={String(totals.sessionsCount)} />
    </div>
  )
}

function Numero({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="hint">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  )
}

/** Valor da célula: travessão no zero, para a coluna vazia não parecer conta. */
export function Valor({ cents, strong = false }: { cents: number; strong?: boolean }) {
  if (cents === 0) return <td className="text-right text-subtle">—</td>
  return (
    <td className={`text-right tabular-nums ${strong ? 'font-medium' : ''}`}>{formatBRL(cents)}</td>
  )
}

export function formatDateOnly(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year}`
}

function asDate(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}
