import { notFound } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { PageHeader } from '@/components/ui'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { ProductForm } from '../../product-form'

/** Edição de produto (MOD-ESTOQUE-01). */

export const dynamic = 'force-dynamic'

export default async function EditarProdutoPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await carregarMe()
  if (!temRecurso(me, 'INVENTORY')) return <PlanoIndisponivel me={me} feature="INVENTORY" />

  const { id } = await params
  const product = await serverApi()
    .getProduct(id)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) notFound()
      throw error
    })

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Operação · Estoque" title={`Editar ${product.name}`} />
      <ProductForm product={product} />
    </div>
  )
}
