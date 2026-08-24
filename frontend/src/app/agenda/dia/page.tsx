import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { AgendaTabs } from '../agenda-tabs'
import { DayBoard } from './day-board'

/**
 * Visão do dia (MOD-AGENDA-09).
 *
 * A data vai na URL, e não no estado de um componente: a recepção manda o link do
 * dia para o colega, volta pelo histórico e recarrega sem perder onde estava.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default async function DiaPage({ searchParams }: PageProps) {
  const params = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today()

  const view = await serverApi().getDayView(date)

  const total = view.columns.reduce((sum, column) => sum + column.appointments.length, 0)
  const emAtendimento = view.columns.reduce(
    (sum, column) =>
      sum + column.appointments.filter((a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS').length,
    0,
  )

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agenda"
        title="Dia"
        subtitle={
          total === 0
            ? 'Nenhum atendimento marcado'
            : `${total} ${total === 1 ? 'atendimento' : 'atendimentos'}${emAtendimento > 0 ? ` · ${emAtendimento} em andamento` : ''}`
        }
      />

      <AgendaTabs />

      <DayBoard view={view} date={date} />
    </div>
  )
}
