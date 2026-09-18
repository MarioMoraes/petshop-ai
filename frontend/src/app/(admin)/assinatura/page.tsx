import { ApiError } from '@petshop/api-client'
import {
  BILLING_METHOD_LABELS,
  PLAN_CATALOG,
  formatBRL,
  type SubscriptionView,
} from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { AssinaturaForm } from './assinatura-form'

/**
 * A assinatura do estabelecimento (camada comercial, fatia 4).
 *
 * Uma tela, três momentos: **escolher** (teste, teste vencido, pendência abandonada),
 * **pagar o que está em aberto** (o link que o Asaas devolveu) e **trocar de plano** (quem
 * já assina). O que decide qual aparece é a assinatura que o backend devolve, e não um
 * estado da tela.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AssinaturaPage({ searchParams }: PageProps) {
  const me = await carregarMe()
  const retorno = (await searchParams).retorno

  if (!me.permissions.includes('tenant:configure')) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Configurações" title="Assinatura" />
        <EmptyState
          title="A assinatura é do administrador"
          description="Plano e pagamento ficam com quem administra o estabelecimento."
        />
      </div>
    )
  }

  const view = await serverApi()
    .getSubscription()
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  if (view instanceof ApiError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Configurações" title="Assinatura" />
        <EmptyState
          title="O serviço não respondeu"
          description="Não foi possível ler a assinatura agora. Recarregue em instantes."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Configurações" title="Assinatura" subtitle={situacao(view)} />
      <AssinaturaForm
        view={view}
        retorno={retorno === 'pago' ? 'pago' : retorno === 'cancelado' ? 'cancelado' : null}
      />
    </div>
  )
}

/**
 * A frase do topo: o estado da conta, dito como a pessoa o entende.
 *
 * **O preço é o contratado, não o de tabela.** Quem assinou o Pro por R$ 299 continua
 * lendo R$ 299 aqui depois de um reajuste, porque é o que o Asaas continua cobrando dele —
 * mostrar a tabela nova seria anunciar uma cobrança que não existe.
 */
function situacao(view: SubscriptionView): string {
  const plano = PLAN_CATALOG[view.plan].name
  const sub = view.subscription
  const preco = sub?.priceCents ?? null
  const valor =
    preco === null ? '' : ` · ${formatBRL(preco)}${sub?.cycle === 'YEARLY' ? '/ano' : '/mês'}`

  switch (view.tenantStatus) {
    case 'TRIAL':
      return view.trialEndsAt
        ? `Em teste no plano ${plano} até ${dia(view.trialEndsAt)}`
        : `Em teste no plano ${plano}`
    case 'TRIAL_EXPIRED':
      return 'O período de teste terminou'
    case 'PAST_DUE':
      return `Plano ${plano} · cobrança em atraso`
    case 'SUSPENDED':
      return `Plano ${plano} · suspenso por falta de pagamento`
    case 'ACTIVE':
      return sub
        ? `Plano ${plano}${valor} · ${BILLING_METHOD_LABELS[sub.method]}`
        : `Plano ${plano}`
    default:
      return `Plano ${plano}`
  }
}

function dia(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(new Date(iso))
}
