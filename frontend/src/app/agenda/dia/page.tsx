import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import type { TaxiRideResponse } from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { AgendaTabs } from '../agenda-tabs'
import { DayBoard } from './day-board'

/**
 * Visão do dia (MOD-AGENDA-09).
 *
 * A data vai na URL, e não no estado de um componente: a recepção manda o link do
 * dia para o colega, volta pelo histórico e recarrega sem perder onde estava.
 *
 * `getDayView` não vem protegido por `try/catch` sozinho — a chamada pode falhar
 * por dois motivos bem diferentes: o scheduling-service fora do ar (já aconteceu:
 * o processo do `tsx watch` morreu e a página inteira caiu com um erro cru), ou um
 * papel sem `schedule:read_all` (banhista, tosador, veterinário só têm a própria
 * agenda) que chegou aqui por link direto — o item de menu já não aparece para eles,
 * mas a URL continua acessível. Nos dois casos a resposta é um estado da tela, não
 * uma página quebrada.
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

  // O catálogo alimenta o serviço acrescentado no check-out (RN-18). Falha dele não
  // derruba a agenda: sem a lista, a janela de conclusão simplesmente não oferece
  // extras — e continua pedindo peso e observação, que é o essencial.
  //
  // O Taxi Dog entra aqui por duas chamadas que **nunca** derrubam a agenda: quem não
  // tem `taxi:operate` (o banhista que abriu por link), o módulo desligado e o serviço
  // fora do ar dão todos no mesmo resultado prático — a agenda do dia sem leva-e-traz,
  // que é uma agenda perfeitamente utilizável.
  //
  const [view, services, settings, rides] = await Promise.all([
    serverApi()
      .getDayView(date)
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    serverApi()
      .listServices()
      .catch(() => []),
    serverApi()
      .getTaxiSettings()
      .catch(() => null),
    serverApi()
      .listTaxiRides({ date, limit: 100 })
      .then((page) => page.items)
      .catch((): TaxiRideResponse[] => []),
  ])

  const taxi = settings?.enabled ? { windowMinutes: settings.defaultWindowMinutes } : null

  // Agrupadas por agendamento: o cartão pergunta "este banho tem corrida?", e não
  // "quais corridas existem hoje?".
  const taxiRides: Record<string, TaxiRideResponse[]> = {}
  for (const ride of rides) {
    ;(taxiRides[ride.appointmentId] ??= []).push(ride)
  }

  const failed = view instanceof ApiError
  const total = failed ? 0 : view.columns.reduce((sum, column) => sum + column.appointments.length, 0)
  const emAtendimento = failed
    ? 0
    : view.columns.reduce(
        (sum, column) =>
          sum +
          column.appointments.filter((a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS').length,
        0,
      )

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agenda"
        title="Dia"
        subtitle={
          failed
            ? 'A agenda não respondeu'
            : total === 0
              ? 'Nenhum atendimento marcado'
              : `${total} ${total === 1 ? 'atendimento' : 'atendimentos'}${emAtendimento > 0 ? ` · ${emAtendimento} em andamento` : ''}`
        }
        actions={
          !failed && (
            <Link href={`/agenda/novo?date=${date}`} className="btn btn-primary">
              Marcar horário
            </Link>
          )
        }
      />

      <AgendaTabs />

      {failed ? (
        <EmptyState
          title={view.status === 403 ? 'Sem acesso à agenda geral' : 'A agenda não respondeu'}
          description={
            view.status === 403
              ? 'Seu perfil só vê a própria agenda, não a visão do dia com todos os profissionais.'
              : 'O serviço de agendamentos está indisponível agora. Recarregue a página em instantes.'
          }
        />
      ) : (
        <DayBoard
          view={view}
          date={date}
          services={services}
          taxi={taxi}
          taxiRides={taxiRides}
        />
      )}
    </div>
  )
}
