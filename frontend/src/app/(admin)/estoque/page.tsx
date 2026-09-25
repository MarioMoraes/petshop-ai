import { ApiError } from '@petshop/api-client'
import type { z } from 'zod'
import {
  PRODUCT_KIND_LABELS,
  formatBRL,
  type ProductListQuery,
  type ProductListQuerySchema,
  type ProductResponse,
} from '@petshop/shared-types'
import { AlertTriangleIcon, CalendarIcon, PackageIcon, TagIcon } from '@/components/icons'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { ListSearch } from '@/components/list-search'
import { InitialsAvatar, RecordCard, RecordFact, RecordGrid } from '@/components/record-list'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { formatExpiry, formatQuantity } from './format'
import { SaleButton } from './sale-dialog'

/**
 * Listagem do estoque (MOD-ESTOQUE-01 e a leitura do MOD-ESTOQUE-09).
 *
 * A forma é a de `components/record-list.tsx`, a mesma de `/tutores` e `/pets`. O
 * filtro é pelo **alerta**, e não pelo tipo de produto: quem abre o estoque vem saber
 * o que falta repor e o que vai vencer.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ q?: string; alerta?: string }>
}

const FILTERS = [
  { value: 'LOW', label: 'Para repor' },
  { value: 'EXPIRING', label: 'Vencendo' },
  { value: 'NEGATIVE', label: 'Saldo negativo' },
  { value: 'INACTIVE', label: 'Inativos' },
] as const

export default async function EstoquePage({ searchParams }: PageProps) {
  // O plano antes de qualquer chamada: pedir a API primeiro traria o 402 para a tela.
  const me = await carregarMe()
  if (!temRecurso(me, 'INVENTORY')) return <PlanoIndisponivel me={me} feature="INVENTORY" />

  const params = await searchParams
  const alerta = FILTERS.some((filter) => filter.value === params.alerta) ? params.alerta : ''
  // O tipo é o da **entrada** do schema: é a query string, onde o booleano é texto.
  const query: Partial<z.input<typeof ProductListQuerySchema>> = {
    ...(params.q ? { q: params.q } : {}),
    ...(alerta && alerta !== 'INACTIVE' ? { alert: alerta as ProductListQuery['alert'] } : {}),
    ...(alerta === 'INACTIVE' ? { includeInactive: 'true' as const } : {}),
  }

  const products = await serverApi()
    .listProducts(query)
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  const canWrite = me.permissions.includes('inventory:write')
  const canSell = me.permissions.includes('inventory:sell')
  const newProduct = canWrite ? <ButtonLink href="/estoque/novo">Novo produto</ButtonLink> : null
  const headerActions =
    canWrite || canSell ? (
      <>
        {canSell && <ButtonLink href="/estoque/vendas">Vendas</ButtonLink>}
        {canSell && <SaleButton canOverrideCredit={me.permissions.includes('finance:credit')} />}
        {newProduct}
      </>
    ) : null

  if (products instanceof ApiError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Operação" title="Estoque" />
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="Não conseguimos carregar o estoque"
          description="O servidor não respondeu. Tente de novo em instantes."
        />
      </div>
    )
  }

  // "Inativos" mostra só os desativados: a lista inteira já é o filtro "Todos".
  const rows = alerta === 'INACTIVE' ? products.filter((product) => !product.active) : products
  const isFiltering = Boolean(params.q ?? alerta)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operação"
        title="Estoque"
        subtitle={subtitle(rows.length, isFiltering)}
        actions={headerActions}
      />

      <ListSearch
        basePath="/estoque"
        placeholder="Buscar por nome, SKU ou código de barras"
        ariaLabel="Buscar produtos"
        initialQuery={params.q ?? ''}
        filterParam="alerta"
        filterLabel="Filtrar por alerta"
        filters={FILTERS.map((filter) => ({ value: filter.value, label: filter.label }))}
        activeFilter={alerta ?? ''}
      />

      {rows.length === 0 ? (
        isFiltering ? (
          <EmptyState
            icon={<PackageIcon />}
            tone="icon-money"
            title="Nenhum produto aqui"
            description={
              alerta === 'LOW' || alerta === 'EXPIRING' || alerta === 'NEGATIVE'
                ? 'Nada neste alerta agora — é uma boa notícia.'
                : 'Tente outro nome, o SKU ou o código de barras.'
            }
          />
        ) : (
          <EmptyState
            icon={<PackageIcon />}
            tone="icon-money"
            title="O estoque começa pelo cadastro"
            description="Cadastre o que você vende e o que usa nos serviços. A vacina com lote e validade, a ração por unidade, o shampoo em litros."
            {...(newProduct
              ? {
                  action: (
                    <ButtonLink href="/estoque/novo">Cadastrar o primeiro produto</ButtonLink>
                  ),
                }
              : {})}
          />
        )
      ) : (
        <RecordGrid>
          {rows.map((product) => (
            <RecordCard
              key={product.id}
              href={`/estoque/${product.id}`}
              avatar={<InitialsAvatar name={product.name} tone="icon-money" />}
              title={product.name}
              meta={meta(product)}
              badges={badges(product)}
              footer={
                <>
                  <RecordFact icon={<PackageIcon />} tone="icon-money">
                    <span
                      className={`font-medium tabular-nums ${
                        Number(product.quantityOnHand) < 0 ? 'text-danger' : ''
                      }`}
                    >
                      {formatQuantity(product.quantityOnHand, product.unit)}
                    </span>
                  </RecordFact>
                  {product.nextExpiresAt && (
                    <RecordFact icon={<CalendarIcon />} tone="icon-time">
                      <span className="tabular-nums">
                        vence {formatExpiry(product.nextExpiresAt)}
                      </span>
                    </RecordFact>
                  )}
                  {product.salePriceCents !== null && (
                    <RecordFact icon={<TagIcon />} tone="icon-money">
                      <span className="tabular-nums">{formatBRL(product.salePriceCents)}</span>
                    </RecordFact>
                  )}
                </>
              }
            />
          ))}
        </RecordGrid>
      )}
    </div>
  )
}

function meta(product: ProductResponse): string {
  return [PRODUCT_KIND_LABELS[product.kind], product.sku].filter(Boolean).join(' · ')
}

function badges(product: ProductResponse) {
  const negative = Number(product.quantityOnHand) < 0
  const items = [
    !product.active && <Badge key="inactive">Inativo</Badge>,
    negative && (
      <Badge key="negative" tone="danger">
        Saldo negativo
      </Badge>
    ),
    // "Repor" ao lado de "Saldo negativo" diria a mesma coisa duas vezes.
    product.belowMinimum && !negative && (
      <Badge key="low" tone="accent">
        Repor
      </Badge>
    ),
    product.expiringLots > 0 && (
      <Badge key="expiring" tone="accent">
        {product.expiringLots === 1 ? '1 lote vencendo' : `${product.expiringLots} lotes vencendo`}
      </Badge>
    ),
  ].filter(Boolean)
  return items.length > 0 ? <>{items}</> : null
}

function subtitle(total: number, isFiltering: boolean): string {
  if (isFiltering) return total === 1 ? '1 produto encontrado' : `${total} produtos encontrados`
  return total === 1 ? '1 produto cadastrado' : `${total} produtos cadastrados`
}
