import { ApiError } from '@petshop/api-client'
import { AlertTriangleIcon, ShieldCheckIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { TaxiSettingsForm } from './settings-form'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'

/**
 * Configuração do Taxi Dog (§4 e MOD-TAXI-06).
 *
 * A ordem da tela é a ordem em que se liga o módulo: primeiro o serviço que cobra a
 * corrida (sem ele o backend recusa ligar), depois o preço padrão, e as zonas por
 * último — elas refinam o preço, não o criam. A frota fecha a tela porque é o único
 * bloco de que o módulo não precisa: sem van, vale a capacidade do motorista.
 */

export const dynamic = 'force-dynamic'

export default async function TaxiConfigPage() {
  // O plano antes de qualquer chamada: a página renderiza em paralelo com o layout, e
  // pedir a API primeiro traria o 402 para dentro da tela (ver `plano-indisponivel.tsx`).
  const sessao = await carregarMe()
  if (!temRecurso(sessao, 'TAXI')) return <PlanoIndisponivel me={sessao} feature="TAXI" />

  const [me, settings, zones, vehicles, services] = await Promise.all([
    carregarMe(),
    serverApi()
      .getTaxiSettings()
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    serverApi()
      .listTaxiZones()
      .then((response) => response.items)
      .catch(() => []),
    serverApi()
      .listTaxiVehicles()
      .then((response) => response.items)
      .catch(() => []),
    serverApi()
      .listServices()
      .catch(() => []),
  ])

  if (!me.permissions.includes('taxi:configure')) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxi Dog" title="Configuração" />
        <EmptyState
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          title="Sem acesso à configuração"
          description="Zonas, frota e preços são do administrador do estabelecimento."
        />
      </div>
    )
  }

  if (settings instanceof ApiError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Taxi Dog" title="Configuração" />
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="O serviço não respondeu"
          description="O serviço de Taxi Dog está indisponível agora. Recarregue em instantes."
        />
      </div>
    )
  }

  const taxiServices = services.filter((service) => service.category === 'TAXI' && service.active)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Taxi Dog"
        title="Configuração"
        subtitle={settings.enabled ? 'Leva-e-traz ligado' : 'Leva-e-traz desligado'}
      />
      <TaxiSettingsForm
        settings={settings}
        zones={zones}
        vehicles={vehicles}
        taxiServices={taxiServices}
      />
    </div>
  )
}
