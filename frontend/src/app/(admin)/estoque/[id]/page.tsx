import { notFound } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { PRODUCT_KIND_LABELS, formatBRL } from '@petshop/shared-types'
import { Badge } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { InitialsAvatar } from '@/components/record-list'
import { RecordHero, type HeroFact } from '@/components/record-hero'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { formatExpiry, formatQuantity } from '../format'
import {
  DeleteProductLink,
  EntryButton,
  InternalUseButton,
  LotsCard,
  MovementsCard,
} from './stock-panel'

/**
 * Ficha do produto (MOD-ESTOQUE-01 a 04).
 *
 * O herói traz os quatro números que se procuram ao abrir o produto: quanto tem, quando
 * vence o que vai sair primeiro, por quanto se vende e quanto custou. Embaixo, os lotes
 * (onde se ajusta) e o histórico (onde se confere).
 */

export const dynamic = 'force-dynamic'

export default async function ProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await carregarMe()
  if (!temRecurso(me, 'INVENTORY')) return <PlanoIndisponivel me={me} feature="INVENTORY" />

  const { id } = await params
  const [product, movements] = await Promise.all([
    serverApi()
      .getProduct(id)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) notFound()
        throw error
      }),
    serverApi().listProductMovements(id),
  ])

  const canWrite = me.permissions.includes('inventory:write')
  const canConsume = me.permissions.includes('inventory:consume')
  const canTrace = me.permissions.includes('record:read_summary')
  const quantity = Number(product.quantityOnHand)

  const facts: HeroFact[] = [
    {
      label: 'Saldo',
      value: formatQuantity(product.quantityOnHand, product.unit),
      ...(quantity < 0 ? { tone: 'danger' as const } : {}),
    },
    {
      label: 'Próxima validade',
      value: product.nextExpiresAt ? formatExpiry(product.nextExpiresAt) : '—',
      ...(product.expiringLots > 0 ? { tone: 'danger' as const } : {}),
    },
    {
      label: 'Preço de venda',
      value: product.salePriceCents === null ? '—' : formatBRL(product.salePriceCents),
    },
    {
      label: 'Último custo',
      value: product.costCents === null ? '—' : formatBRL(product.costCents),
    },
  ]

  return (
    <div className="space-y-6">
      <RecordHero
        back={{ href: '/estoque', label: 'Estoque' }}
        avatar={<InitialsAvatar name={product.name} tone="icon-money" size="lg" />}
        title={product.name}
        badges={
          <>
            <Badge>{PRODUCT_KIND_LABELS[product.kind]}</Badge>
            {!product.active && <Badge>Inativo</Badge>}
            {product.belowMinimum && quantity >= 0 && <Badge tone="accent">Repor</Badge>}
            {quantity < 0 && <Badge tone="danger">Saldo negativo</Badge>}
          </>
        }
        meta={[
          product.sku && `SKU ${product.sku}`,
          product.barcode,
          Number(product.minQuantity) > 0 &&
            `mínimo ${formatQuantity(product.minQuantity, product.unit)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        facts={facts}
        actions={
          (canWrite || canConsume) && (
            <>
              {canWrite && <ButtonLink href={`/estoque/${product.id}/editar`}>Editar</ButtonLink>}
              {canConsume && product.kind !== 'RETAIL' && <InternalUseButton product={product} />}
              {canWrite && <EntryButton product={product} />}
            </>
          )
        }
      />

      <LotsCard product={product} canWrite={canWrite} canTrace={canTrace} />
      <MovementsCard product={product} initial={movements} />

      {canWrite && product.deletable && (
        <div className="flex justify-end">
          <DeleteProductLink product={product} />
        </div>
      )}
    </div>
  )
}
