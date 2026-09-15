import { ApiError } from '@petshop/api-client'
import {
  todayIn,
  zonedDayRange,
  type CalendarBlockResponse,
  type TaxiRideResponse,
} from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { ExpandIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { rotuloDoDia } from '@/lib/agenda-dia'
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

export default async function DiaPage({ searchParams }: PageProps) {
  const params = await searchParams

  /*
   * "Hoje" é o dia do estabelecimento, e não o do servidor.
   *
   * Era `new Date().toISOString()`, que é UTC: um petshop em Rio Branco abria a agenda
   * do dia seguinte a partir das 19h. As configurações vêm antes de tudo justamente
   * porque a data padrão depende delas; falha aqui cai no fuso de Brasília, que é o
   * mesmo padrão do resto do produto.
   */
  const settings = await serverApi()
    .getSettings()
    .catch(() => null)
  const timezone = settings?.timezone ?? 'America/Sao_Paulo'
  const hoje = todayIn(timezone)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : hoje

  // O catálogo alimenta o serviço acrescentado no check-out (RN-18). Falha dele não
  // derruba a agenda: sem a lista, a janela de conclusão simplesmente não oferece
  // extras — e continua pedindo peso e observação, que é o essencial.
  //
  // O Taxi Dog entra aqui por duas chamadas que **nunca** derrubam a agenda: quem não
  // tem `taxi:operate` (o banhista que abriu por link), o módulo desligado e o serviço
  // fora do ar dão todos no mesmo resultado prático — a agenda do dia sem leva-e-traz,
  // que é uma agenda perfeitamente utilizável.
  //
  const { from, to } = zonedDayRange(date, timezone)

  const [view, services, taxiSettings, rides, blocks] = await Promise.all([
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
    // Bloqueio ausente é uma coluna sem hachura, não uma agenda quebrada — o mesmo
    // critério que já vale para o Taxi Dog logo acima.
    serverApi()
      .listCalendarBlocks({ from: from.toISOString(), to: to.toISOString() })
      .catch((): CalendarBlockResponse[] => []),
  ])

  const taxi = taxiSettings?.enabled ? { windowMinutes: taxiSettings.defaultWindowMinutes } : null

  // Agrupadas por agendamento: o cartão pergunta "este banho tem corrida?", e não
  // "quais corridas existem hoje?".
  const taxiRides: Record<string, TaxiRideResponse[]> = {}
  for (const ride of rides) {
    ;(taxiRides[ride.appointmentId] ??= []).push(ride)
  }

  const failed = view instanceof ApiError
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agenda"
        title={date === hoje ? 'Hoje' : 'Dia'}
        subtitle={failed ? 'A agenda não respondeu' : rotuloDoDia(date)}
        actions={
          !failed && (
            <>
              {/*
                `<a>` e não `<ButtonLink>`: o `<Link>` do Next só espera a próxima tela
                quando ela vem para esta aba, e `deveSinalizar` (`lib/navegacao.ts`) já
                recusa acender a barra de progresso para `target="_blank"`. Um botão que
                nunca gira é o botão errado — este abre uma aba e termina aí.
              */}
              <a
                href={`/mural?date=${date}`}
                target="_blank"
                rel="noopener"
                className="btn btn-primary"
                title="Abrir o Mural do dia numa aba própria"
              >
                <ExpandIcon />
                Mural
              </a>
              <ButtonLink href={`/agenda/novo?date=${date}`}>Marcar horário</ButtonLink>
            </>
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
          today={hoje}
          services={services}
          taxi={taxi}
          taxiRides={taxiRides}
          blocks={blocks}
        />
      )}
    </div>
  )
}
