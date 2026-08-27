import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { TaxiBoard } from './taxi-board'

/**
 * Painel do dia do Taxi Dog (MOD-TAXI-07).
 *
 * A data vai na URL, como na agenda: a recepção manda o link do dia para o colega e
 * volta pelo histórico sem perder onde estava.
 *
 * A tela tem **três** estados vazios diferentes, e distingui-los é o ponto:
 * o módulo desligado (RN-22, e aí o que falta é ligar), o serviço fora do ar, e o dia
 * sem corrida nenhuma. Um "nada aqui" genérico faria o admin abrir chamado nos três.
 *
 * O motorista cai aqui pelo mesmo item de menu de todo mundo e é **redirecionado** à
 * própria rota. Um item de menu por papel dividiria a navegação em duas para dizer a
 * mesma coisa — "Taxi Dog" —, e mostrar-lhe um 403 seria pior ainda: ele tem acesso,
 * só não a esta tela.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function TaxiPage({ searchParams }: PageProps) {
  const params = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date : undefined

  const [me, settings, board, professionals] = await Promise.all([
    serverApi().me(),
    serverApi()
      .getTaxiSettings()
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    serverApi()
      .getTaxiBoard(date)
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    // Sem motoristas o painel ainda serve para ver as corridas; só não dá para
    // atribuir. Falha aqui não derruba a tela.
    serverApi()
      .listProfessionals()
      .catch(() => []),
  ])

  const settingsFailed = settings instanceof ApiError
  const boardFailed = board instanceof ApiError

  if (boardFailed && board.status === 403) redirect('/taxi/rota')

  const desligado = !settingsFailed && !settings.enabled
  const canConfigure = me.permissions.includes('taxi:configure')

  const drivers = professionals
    .filter((professional) => professional.roleKey === 'DRIVER' && professional.active)
    .map((professional) => ({ id: professional.id, displayName: professional.displayName }))

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Taxi Dog"
        title="Corridas do dia"
        subtitle={
          desligado
            ? 'O leva-e-traz está desligado'
            : boardFailed
              ? 'O serviço não respondeu'
              : `${board.totals.rides} ${board.totals.rides === 1 ? 'corrida' : 'corridas'}${
                  board.totals.unassigned > 0 ? ` · ${board.totals.unassigned} sem motorista` : ''
                }`
        }
        actions={
          canConfigure && (
            <Link href="/taxi/configuracoes" className="btn">
              Configurar
            </Link>
          )
        }
      />

      {desligado ? (
        <EmptyState
          title="O Taxi Dog está desligado"
          description={
            canConfigure
              ? 'Escolha o serviço de catálogo que cobra a corrida e ligue o módulo em Configurar.'
              : 'Peça a um administrador para ligar o leva-e-traz nas configurações.'
          }
        />
      ) : boardFailed ? (
        <EmptyState
          title="O serviço não respondeu"
          description="O serviço de Taxi Dog está indisponível agora. Recarregue em instantes."

        />
      ) : (
        <TaxiBoard board={board} drivers={drivers} canConfigure={canConfigure} />
      )}
    </div>
  )
}
