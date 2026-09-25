import { ApiError } from '@petshop/api-client'
import { AlertTriangleIcon, PackageIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { SaleButton } from '../sale-dialog'
import { SalesList } from './sales-list'

/**
 * As vendas do balcão (MOD-ESTOQUE-05/06), da mais nova para a mais velha.
 *
 * É onde a recepção confere a venda de ontem e onde o administrador estorna. A venda de
 * um tutor também aparece no extrato dele, pelo débito `PRODUCT`; aqui ficam todas,
 * inclusive as avulsas, que não passam pelo razão.
 */

export const dynamic = 'force-dynamic'

export default async function VendasPage() {
  const me = await carregarMe()
  if (!temRecurso(me, 'INVENTORY')) return <PlanoIndisponivel me={me} feature="INVENTORY" />

  const canSell = me.permissions.includes('inventory:sell')
  if (!canSell) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Operação · Estoque" title="Vendas" />
        <EmptyState
          icon={<PackageIcon />}
          tone="icon-money"
          title="As vendas são do balcão"
          description="Quem vende e confere as vendas é a recepção e o administrador."
        />
      </div>
    )
  }

  const page = await serverApi()
    .listSales()
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  const actions = (
    <>
      <ButtonLink href="/estoque">Produtos</ButtonLink>
      <SaleButton canOverrideCredit={me.permissions.includes('finance:credit')} />
    </>
  )

  if (page instanceof ApiError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Operação · Estoque" title="Vendas" actions={actions} />
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="Não conseguimos carregar as vendas"
          description="O servidor não respondeu. Tente de novo em instantes."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operação · Estoque"
        title="Vendas"
        subtitle="Da mais recente para a mais antiga."
        actions={actions}
      />
      {page.items.length === 0 ? (
        <EmptyState
          icon={<PackageIcon />}
          tone="icon-money"
          title="Nenhuma venda ainda"
          description="A venda sai da prateleira e, quando tem tutor, cai na conta corrente dele."
        />
      ) : (
        <SalesList initial={page} canRefund={me.permissions.includes('inventory:refund')} />
      )}
    </div>
  )
}
