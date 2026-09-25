import { PageHeader } from '@/components/ui'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe } from '@/lib/api'
import { ProductForm } from '../product-form'

/** Cadastro de produto (MOD-ESTOQUE-01). */

export const metadata = { title: 'Novo produto — PetShop AI' }

export default async function NovoProdutoPage() {
  const me = await carregarMe()
  if (!temRecurso(me, 'INVENTORY')) return <PlanoIndisponivel me={me} feature="INVENTORY" />

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operação · Estoque"
        title="Novo produto"
        subtitle="O saldo entra depois, pela entrada de mercadoria, com o lote e a validade."
      />
      <ProductForm />
    </div>
  )
}
