'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  formatCentsInput,
  parseBRLToCents,
  PRODUCT_KINDS,
  PRODUCT_UNITS,
  type ProductDetailResponse,
  type ProductKind,
  type ProductUnit,
} from '@petshop/shared-types'
import {
  Button,
  Card,
  Choice,
  Field,
  FormActions,
  FormError,
  SectionHead,
  Segmented,
} from '@/components/ui'
import { useToast } from '@/components/toast'
import { PackageIcon, ScaleIcon, WalletIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { createProductAction, updateProductAction, type ActionFailure } from './actions'

/**
 * Cadastro e edição de produto (MOD-ESTOQUE-01).
 *
 * Segue `docs/design-formularios.md`: fichas `soft`, seções numeradas porque o cadastro
 * é percorrido de cima a baixo, e um tom só, o do Estoque no menu (`icon-money`).
 *
 * O saldo **não** é campo daqui. Ele nasce da entrada de mercadoria, na ficha do produto,
 * porque o saldo é a soma dos lotes e um número digitado no cadastro não teria lote nem
 * validade.
 */

/**
 * Rótulos curtos nos dois seletores: a 390px "Venda e insumo" quebrava em três linhas
 * dentro da pílula, e cinco unidades por extenso vazavam do cartão. O nome longo do tipo
 * continua nos selos da lista e da ficha.
 */
const KIND_OPTIONS: readonly { value: ProductKind; label: string }[] = PRODUCT_KINDS.map(
  (kind) => ({ value: kind, label: { RETAIL: 'Venda', SUPPLY: 'Insumo', BOTH: 'Os dois' }[kind] }),
)

const UNIT_OPTIONS: readonly { value: ProductUnit; label: string }[] = PRODUCT_UNITS.map(
  (unit) => ({
    value: unit,
    label: { UN: 'un', ML: 'ml', L: 'L', G: 'g', KG: 'kg' }[unit],
  }),
)

function sellable(kind: ProductKind): boolean {
  return kind === 'RETAIL' || kind === 'BOTH'
}

/** `"12.5"` → `"12,5"`: o número volta ao campo no formato de quem digita. */
function quantityInput(value: string): string {
  return value.replace('.', ',')
}

export function ProductForm({ product }: { product?: ProductDetailResponse }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const isEditing = product !== undefined
  const hasHistory = isEditing && !product.deletable

  const [name, setName] = useState(product?.name ?? '')
  const [kind, setKind] = useState<ProductKind>(product?.kind ?? 'RETAIL')
  const [sku, setSku] = useState(product?.sku ?? '')
  const [barcode, setBarcode] = useState(product?.barcode ?? '')
  const [unit, setUnit] = useState<ProductUnit>(product?.unit ?? 'UN')
  const [minQuantity, setMinQuantity] = useState(quantityInput(product?.minQuantity ?? '0'))
  const [tracksExpiry, setTracksExpiry] = useState(product?.tracksExpiry ?? false)
  const [salePrice, setSalePrice] = useState(
    product?.salePriceCents != null ? formatCentsInput(product.salePriceCents) : '',
  )
  const [cost, setCost] = useState(
    product?.costCents != null ? formatCentsInput(product.costCents) : '',
  )
  const [active, setActive] = useState(product?.active ?? true)
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})

  const fieldErrors = { ...(failure?.fieldErrors ?? {}), ...localErrors }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)

    // O valor em reais é convertido aqui, e não no servidor: é aqui que se sabe qual
    // campo apontar quando "12,5,0" não é um preço.
    const errors: Record<string, string> = {}
    const salePriceCents = sellable(kind) && salePrice.trim() ? parseBRLToCents(salePrice) : null
    if (sellable(kind) && salePrice.trim() && salePriceCents === null) {
      errors.salePriceCents = 'Informe o preço no formato 12,50'
    }
    const costCents = cost.trim() ? parseBRLToCents(cost) : null
    if (cost.trim() && costCents === null) errors.costCents = 'Informe o custo no formato 12,50'
    setLocalErrors(errors)
    if (Object.keys(errors).length > 0) return

    const payload = {
      name,
      kind,
      sku: sku.trim() || null,
      barcode: barcode.trim() || null,
      ...(hasHistory ? {} : { unit }),
      minQuantity: minQuantity.trim() || '0',
      tracksExpiry,
      salePriceCents,
      costCents,
    }

    startTransition(async () => {
      const response = isEditing
        ? await updateProductAction(product.id, { ...payload, active })
        : await createProductAction(payload)

      if (!response.ok) {
        setFailure(response)
        return
      }
      toast(isEditing ? 'Produto atualizado.' : 'Produto cadastrado.')
      router.push(`/estoque/${response.data.id}`)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {failure && Object.keys(failure.fieldErrors).length === 0 && (
        <FormError message={failure.message} />
      )}

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<PackageIcon />}
          tone="icon-money"
          eyebrow="01 · Identificação"
          title="O que é o produto"
        />

        <Field label="Nome" htmlFor="name" error={fieldErrors.name}>
          <input
            id="name"
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ração Premium Adulto 15 kg"
            maxLength={120}
            autoFocus={!isEditing}
          />
        </Field>

        <Field
          label="Para que serve"
          htmlFor="kind"
          error={fieldErrors.kind}
          hint="Venda vai para o balcão; insumo é o que se gasta no banho, na tosa e na clínica."
        >
          <Segmented
            ariaLabel="Para que serve"
            options={KIND_OPTIONS}
            value={kind}
            onChange={setKind}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="SKU"
            htmlFor="sku"
            error={fieldErrors.sku}
            hint="Opcional. O seu código interno."
          >
            <input
              id="sku"
              className="field"
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              maxLength={40}
            />
          </Field>
          <Field label="Código de barras" htmlFor="barcode" error={fieldErrors.barcode}>
            <input
              id="barcode"
              className="field"
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
              inputMode="numeric"
              maxLength={40}
            />
          </Field>
        </div>
      </Card>

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<ScaleIcon />}
          tone="icon-money"
          eyebrow="02 · Contagem"
          title="Como ele é contado"
        />

        <Field
          label="Unidade"
          htmlFor="unit"
          error={fieldErrors.unit}
          hint={
            hasHistory
              ? 'A unidade não muda depois do primeiro movimento: ela é o significado de todo número já lançado.'
              : 'Shampoo em litro ou ml, vacina e coleira por unidade, ração a granel em kg.'
          }
        >
          <Segmented
            ariaLabel="Unidade"
            options={UNIT_OPTIONS}
            value={unit}
            onChange={setUnit}
            disabled={hasHistory}
          />
        </Field>

        <Field
          label="Estoque mínimo"
          htmlFor="minQuantity"
          error={fieldErrors.minQuantity}
          hint="Abaixo disso o produto aparece em Para repor. Zero desliga o aviso."
        >
          <input
            id="minQuantity"
            className="field"
            value={minQuantity}
            onChange={(event) => setMinQuantity(event.target.value)}
            inputMode="decimal"
          />
        </Field>

        <Choice
          label="Controla lote e validade"
          description="Vacina e medicamento: a entrada exige a data do lote, e o lote aplicado fica no prontuário."
          checked={tracksExpiry}
          onChange={setTracksExpiry}
        />
      </Card>

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<WalletIcon />}
          tone="icon-money"
          eyebrow="03 · Valores"
          title="Quanto custa"
        />

        <div className="grid gap-5 sm:grid-cols-2">
          {sellable(kind) && (
            <Field
              label="Preço de venda (R$)"
              htmlFor="salePrice"
              error={fieldErrors.salePriceCents}
            >
              <input
                id="salePrice"
                className="field"
                value={salePrice}
                onChange={(event) => setSalePrice(event.target.value)}
                inputMode="decimal"
                placeholder="0,00"
              />
            </Field>
          )}
          <Field
            label="Custo (R$)"
            htmlFor="cost"
            error={fieldErrors.costCents}
            hint="Opcional. A entrada de mercadoria atualiza com o custo da nota."
          >
            <input
              id="cost"
              className="field"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              inputMode="decimal"
              placeholder="0,00"
            />
          </Field>
        </div>

        {isEditing && (
          <Choice
            label="Produto ativo"
            description="Desativado, ele sai dos seletores e da lista. O histórico fica."
            checked={active}
            onChange={setActive}
          />
        )}
      </Card>

      <FormActions>
        <ButtonLink href={isEditing ? `/estoque/${product.id}` : '/estoque'} variant="ghost">
          Cancelar
        </ButtonLink>
        <Button type="submit" busy={pending} busyLabel="Salvando…">
          {isEditing ? 'Salvar alterações' : 'Cadastrar produto'}
        </Button>
      </FormActions>
    </form>
  )
}
