import { ApiError } from '@petshop/api-client'
import { EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { DriverRoute } from './driver-route'

/**
 * A rota do motorista (AC-02 de MOD-TAXI-07).
 *
 * Desenhada para o celular, na rua: parada por parada, botão grande, endereço e
 * telefone à mão. Não aceita `driverId` na URL nem para o admin — a resposta traz
 * telefone e endereço decifrados, e um filtro vindo do cliente aqui seria a porta
 * aberta (§9). Quem quer ver a rota de outra pessoa usa o painel.
 */

export const dynamic = 'force-dynamic'

export default async function RotaPage() {
  const route = await serverApi()
    .getMyTaxiRoute()
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  if (route instanceof ApiError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxi Dog" title="Minha rota" />
        <EmptyState
          title={route.status === 404 ? 'Você não está cadastrado como motorista' : 'O serviço não respondeu'}
          description={
            route.status === 404
              ? 'Peça a um administrador para cadastrá-lo como motorista em Agenda → Profissionais.'
              : 'O serviço de Taxi Dog está indisponível agora. Recarregue em instantes.'
          }
        />
      </div>
    )
  }

  const pendentes = route.stops.filter(
    (stop) => !['DELIVERED', 'FAILED', 'CANCELLED'].includes(stop.status),
  ).length

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Taxi Dog"
        title="Minha rota"
        subtitle={
          route.stops.length === 0
            ? 'Nenhuma corrida hoje'
            : `${pendentes} ${pendentes === 1 ? 'parada pendente' : 'paradas pendentes'} de ${route.stops.length}`
        }
      />

      {route.stops.length === 0 ? (
        <EmptyState
          title="Nenhuma corrida hoje"
          description="Quando a recepção atribuir uma corrida a você, ela aparece aqui."
        />
      ) : (
        <DriverRoute route={route} />
      )}
    </div>
  )
}
