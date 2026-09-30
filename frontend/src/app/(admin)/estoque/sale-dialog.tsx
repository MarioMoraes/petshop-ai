'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CASH_METHODS,
  CASH_METHOD_LABELS,
  formatBRL,
  type CashMethod,
  type InsufficientStockItem,
  type ProductResponse,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import { Alert, Button, Choice, Field, FormError, Segmented } from '@/components/ui'
import {
  AlertTriangleIcon,
  MinusIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  WalletIcon,
  XIcon,
} from '@/components/icons'
import {
  createSaleAction,
  listSellableProductsAction,
  searchTutorsAction,
  type ActionFailure,
  type TutorOption,
} from './actions'
import { formatQuantity, newIdempotencyKey } from './format'

/**
 * A venda do balcão (MOD-ESTOQUE-05), num `<Modal>`.
 *
 * Abre de dois lugares: da ficha do tutor, com o comprador já escolhido, e de `/estoque`,
 * onde o operador busca o tutor ou marca venda avulsa. O total mostrado é uma **prévia**:
 * quem calcula o que entra no razão é o servidor, com o preço gravado no produto.
 *
 * A chave de idempotência nasce quando a janela abre. Reenviar depois de uma recusa
 * (saldo, limite) manda a mesma chave, e o servidor só a grava quando a venda vinga.
 */

export function SaleButton({
  tutor,
  canOverrideCredit,
}: {
  /** Presente na ficha do tutor: o comprador não se escolhe. */
  tutor?: TutorOption
  canOverrideCredit: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="accent" icon={<WalletIcon />} onClick={() => setOpen(true)}>
        Vender
      </Button>
      {open && (
        <SaleDialog
          fixedTutor={tutor}
          canOverrideCredit={canOverrideCredit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

interface Line {
  productId: string
  quantity: string
}

type BuyerMode = 'TUTOR' | 'WALK_IN'

const BUYER_OPTIONS: readonly { value: BuyerMode; label: string }[] = [
  { value: 'TUTOR', label: 'Para um tutor' },
  { value: 'WALK_IN', label: 'Venda avulsa' },
]

function SaleDialog({
  fixedTutor,
  canOverrideCredit,
  onClose,
}: {
  fixedTutor: TutorOption | undefined
  canOverrideCredit: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [idempotencyKey] = useState(newIdempotencyKey)
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  const [products, setProducts] = useState<ProductResponse[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    void listSellableProductsAction().then((response) => {
      if (response.ok) setProducts(response.data)
      else setLoadError(response.message)
    })
  }, [])

  const [buyerMode, setBuyerMode] = useState<BuyerMode>('TUTOR')
  const [tutor, setTutor] = useState<TutorOption | null>(fixedTutor ?? null)
  const [lines, setLines] = useState<Line[]>([])
  const [overrideReason, setOverrideReason] = useState('')
  // MOD-CAIXA: a avulsa sempre diz como foi paga; a do tutor, só se ele pagou na hora.
  const [method, setMethod] = useState<CashMethod>('CASH')
  const [paidNow, setPaidNow] = useState(false)
  const forTutor = Boolean(fixedTutor) || buyerMode === 'TUTOR'

  const byId = new Map((products ?? []).map((product) => [product.id, product]))
  const total = lines.reduce((sum, line) => {
    const product = byId.get(line.productId)
    const quantity = Number(line.quantity.replace(',', '.'))
    if (!product?.salePriceCents || !Number.isFinite(quantity)) return sum
    return sum + Math.round(product.salePriceCents * quantity)
  }, 0)

  const needsOverride = failure?.code === 'ERR_INV_015'
  const short =
    failure?.code === 'ERR_INV_010'
      ? ((failure.problem?.items as InsufficientStockItem[] | undefined) ?? [])
      : []

  function addProduct(productId: string) {
    if (!productId) return
    setLines((current) =>
      current.some((line) => line.productId === productId)
        ? current
        : [...current, { productId, quantity: '1' }],
    )
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const buyer = fixedTutor ?? (buyerMode === 'TUTOR' ? tutor : null)
    if (!fixedTutor && buyerMode === 'TUTOR' && !tutor) {
      setFailure({
        ok: false,
        message: 'Escolha o tutor, ou marque venda avulsa.',
        fieldErrors: {},
      })
      return
    }
    setFailure(null)

    startTransition(async () => {
      const response = await createSaleAction({
        tutorId: buyer?.id ?? null,
        items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        ...(needsOverride && overrideReason.trim()
          ? { creditOverrideReason: overrideReason.trim() }
          : {}),
        ...(!buyer || paidNow ? { paymentMethod: method } : {}),
        idempotencyKey,
      })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast(
        !buyer
          ? `Venda registrada no caixa — ${CASH_METHOD_LABELS[method]}.`
          : paidNow
            ? `Venda paga por ${buyer.name} — ${CASH_METHOD_LABELS[method]}.`
            : `Venda lançada na conta de ${buyer.name}.`,
      )
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PackageIcon />}
      tone="icon-money"
      eyebrow="Venda no balcão"
      title={fixedTutor ? fixedTutor.name : 'Nova venda'}
      subtitle={
        lines.length > 0
          ? `Total: ${formatBRL(total)}`
          : 'Escolha os produtos que saem da prateleira.'
      }
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="sale-form"
            busy={pending}
            busyLabel="Registrando…"
            disabled={lines.length === 0 || (needsOverride && !canOverrideCredit)}
          >
            {needsOverride ? 'Liberar e vender' : 'Confirmar venda'}
          </Button>
        </>
      }
    >
      <form id="sale-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure && !needsOverride && short.length === 0 && <FormError message={failure.message} />}

        {short.length > 0 && (
          <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não há saldo para tudo">
            <ul className="space-y-0.5">
              {short.map((item) => {
                const unit = byId.get(item.productId)?.unit ?? 'UN'
                return (
                  <li key={item.productId}>
                    {item.name}: pediu {formatQuantity(item.requested, unit)}, há{' '}
                    {formatQuantity(item.available, unit)}
                  </li>
                )
              })}
            </ul>
          </Alert>
        )}

        {needsOverride && (
          <Alert tone="accent" icon={<WalletIcon />} title={failure?.message ?? ''}>
            {canOverrideCredit ? (
              <div className="mt-2">
                <Field label="Por que liberar" htmlFor="override-reason">
                  <input
                    id="override-reason"
                    className="field"
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                    placeholder="Cliente antigo, paga no dia 10"
                    maxLength={200}
                    autoFocus
                  />
                </Field>
              </div>
            ) : (
              <p>Só o administrador libera venda acima do limite de crédito.</p>
            )}
          </Alert>
        )}

        {!fixedTutor && (
          <div className="space-y-3">
            <Segmented
              ariaLabel="Quem compra"
              options={BUYER_OPTIONS}
              value={buyerMode}
              onChange={setBuyerMode}
            />
            {buyerMode === 'TUTOR' ? (
              <TutorPicker value={tutor} onChange={setTutor} />
            ) : (
              <p className="hint">
                A venda avulsa dá baixa no estoque e entra no caixa do dia — o pagamento é na hora,
                e o caixa precisa estar aberto.
              </p>
            )}
          </div>
        )}

        {loadError ? (
          <FormError message={loadError} />
        ) : (
          <ProductPicker
            products={products}
            chosen={lines.map((line) => line.productId)}
            onPick={addProduct}
          />
        )}

        {lines.length > 0 && (
          <ul className="divide-y divide-line">
            {lines.map((line, index) => {
              const product = byId.get(line.productId)
              if (!product) return null
              return (
                <li key={line.productId} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{product.name}</p>
                    <p className="hint">
                      {formatBRL(product.salePriceCents ?? 0)} ·{' '}
                      {formatQuantity(product.quantityOnHand, product.unit)} em estoque
                    </p>
                  </div>
                  <QuantityStepper
                    label={product.name}
                    value={line.quantity}
                    max={Number(product.quantityOnHand)}
                    onChange={(quantity) =>
                      setLines((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, quantity } : item,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    className="h-9 w-9 px-0"
                    aria-label={`Tirar ${product.name} da venda`}
                    onClick={() =>
                      setLines((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    <XIcon />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {lines.length > 0 && forTutor && (
          <Choice
            label="Pagou agora"
            description="Registra o pagamento junto da venda, e ele quita esta compra. Sem marcar, a venda fica na conta do tutor."
            checked={paidNow}
            onChange={setPaidNow}
            disabled={pending}
          />
        )}

        {lines.length > 0 && (!forTutor || paidNow) && (
          <Field label="Forma de pagamento" htmlFor="sale-method">
            <select
              id="sale-method"
              className="field"
              value={method}
              onChange={(event) => setMethod(event.target.value as CashMethod)}
              disabled={pending}
            >
              {CASH_METHODS.map((option) => (
                <option key={option} value={option}>
                  {CASH_METHOD_LABELS[option]}
                </option>
              ))}
            </select>
          </Field>
        )}
      </form>
    </Modal>
  )
}

/** A busca do comprador: digita, escolhe da lista, e a escolha vira uma linha só. */
function TutorPicker({
  value,
  onChange,
}: {
  value: TutorOption | null
  onChange: (tutor: TutorOption | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TutorOption[]>([])

  useEffect(() => {
    if (value) return
    const timer = setTimeout(() => {
      void searchTutorsAction(query).then(setResults)
    }, 250)
    return () => clearTimeout(timer)
  }, [query, value])

  if (value) {
    return (
      <div className="option">
        <span className="min-w-0 flex-1">
          <span className="option-text block">{value.name}</span>
          {value.detail && <span className="hint mt-0.5 block">{value.detail}</span>}
        </span>
        <Button className="h-9" onClick={() => onChange(null)}>
          Trocar
        </Button>
      </div>
    )
  }

  return (
    <Field label="Tutor" htmlFor="sale-tutor" hint="Nome, telefone ou CPF.">
      <input
        id="sale-tutor"
        className="field"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />
      {results.length > 0 && (
        <ul className="mt-2 space-y-1">
          {results.map((tutor) => (
            <li key={tutor.id}>
              <button
                type="button"
                className="option w-full text-left"
                onClick={() => {
                  onChange(tutor)
                  setQuery('')
                  setResults([])
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="option-text block">{tutor.name}</span>
                  {tutor.detail && <span className="hint mt-0.5 block">{tutor.detail}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  )
}

/** Tira acento e caixa: "racao" acha "Ração". */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Nome, SKU ou código de barras — o termo já chega normalizado. */
function matchesProduct(product: ProductResponse, term: string): boolean {
  return [product.name, product.sku, product.barcode].some(
    (value) => value && normalize(value).includes(term),
  )
}

const PRODUCT_RESULTS_LIMIT = 8

/**
 * A busca do produto: digita, e a lista embaixo filtra por nome, SKU ou código de barras.
 *
 * Os vendáveis já desceram inteiros quando a janela abriu, então o filtro é local e não
 * espera servidor. O campo fica aberto depois da escolha — uma venda costuma ter mais de
 * um item —, e o Enter inclui o primeiro da lista, que é o que o leitor de código de
 * barras manda depois do número. O botão no canto abre o catálogo inteiro.
 */
function ProductPicker({
  products,
  chosen,
  onPick,
}: {
  products: ProductResponse[] | null
  chosen: readonly string[]
  onPick: (productId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const term = normalize(query.trim())
  const matches =
    term && products
      ? products
          .filter((product) => !chosen.includes(product.id))
          .filter((product) => matchesProduct(product, term))
      : []
  const shown = matches.slice(0, PRODUCT_RESULTS_LIMIT)
  const firstAvailable = shown.find((product) => Number(product.quantityOnHand) > 0)

  function pick(productId: string) {
    onPick(productId)
    setQuery('')
    inputRef.current?.focus()
  }

  return (
    <Field label="Produto" htmlFor="sale-product" hint="Nome, SKU ou código de barras.">
      <div className="field-wrap">
        <input
          ref={inputRef}
          id="sale-product"
          className="field field-with-action"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Sem isto o Enter enviaria a venda pela metade.
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (firstAvailable) pick(firstAvailable.id)
          }}
          placeholder={products === null ? 'Carregando…' : 'Digite para buscar'}
          disabled={products === null}
          autoComplete="off"
        />
        <button
          type="button"
          className="field-action icon-money"
          onClick={() => setCatalogOpen(true)}
          disabled={products === null}
          aria-label="Ver todos os produtos"
          title="Ver todos os produtos"
        >
          <PackageIcon />
        </button>
      </div>
      {term && products && (
        <ul className="mt-2 space-y-1">
          {shown.length === 0 ? (
            <li className="hint">Nenhum produto encontrado.</li>
          ) : (
            shown.map((product) => {
              const outOfStock = Number(product.quantityOnHand) <= 0
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    className="option w-full text-left disabled:opacity-50"
                    disabled={outOfStock}
                    onClick={() => pick(product.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="option-text block">{product.name}</span>
                      <span className="hint mt-0.5 block">
                        {formatBRL(product.salePriceCents ?? 0)} ·{' '}
                        {outOfStock
                          ? 'Sem saldo'
                          : `${formatQuantity(product.quantityOnHand, product.unit)} em estoque`}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })
          )}
          {matches.length > shown.length && (
            <li className="hint">
              Mais {matches.length - shown.length} — continue digitando para afinar.
            </li>
          )}
        </ul>
      )}
      {catalogOpen && products && (
        <ProductCatalogDialog
          products={products}
          chosen={chosen}
          onPick={(productId) => {
            setCatalogOpen(false)
            pick(productId)
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </Field>
  )
}

/**
 * O catálogo inteiro, para quem prefere olhar a lista a lembrar o nome.
 *
 * Abre por cima da venda (o `Modal` empilha) e devolve um produto só: escolher fecha a
 * janela e inclui o item, como a busca faz. A busca daqui é a mesma do campo, e a lista
 * não tem teto — rolar é o motivo de ter aberto.
 */
function ProductCatalogDialog({
  products,
  chosen,
  onPick,
  onClose,
}: {
  products: ProductResponse[]
  chosen: readonly string[]
  onPick: (productId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const term = normalize(query.trim())
  const shown = [...products]
    .filter((product) => !term || matchesProduct(product, term))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PackageIcon />}
      tone="icon-money"
      eyebrow="Venda no balcão"
      title="Produtos"
      stacked
      subtitle={`${products.length} ${products.length === 1 ? 'produto à venda' : 'produtos à venda'}`}
    >
      <div className="space-y-3">
        <div className="field-wrap">
          <span className="field-lead icon-money">
            <SearchIcon />
          </span>
          <input
            type="search"
            className="field field-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nome, SKU ou código de barras"
            aria-label="Filtrar produtos"
            autoComplete="off"
          />
        </div>

        {shown.length === 0 ? (
          <p className="hint">Nenhum produto encontrado.</p>
        ) : (
          <ul className="space-y-1">
            {shown.map((product) => {
              const outOfStock = Number(product.quantityOnHand) <= 0
              const inSale = chosen.includes(product.id)
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    className="option w-full text-left disabled:opacity-50"
                    disabled={outOfStock || inSale}
                    onClick={() => onPick(product.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="option-text block">{product.name}</span>
                      <span className="hint mt-0.5 block">
                        {formatBRL(product.salePriceCents ?? 0)} ·{' '}
                        {inSale
                          ? 'Já está na venda'
                          : outOfStock
                            ? 'Sem saldo'
                            : `${formatQuantity(product.quantityOnHand, product.unit)} em estoque`}
                        {product.sku && ` · SKU ${product.sku}`}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** `"2,5"` ou `"2.5"` → 2.5; o que não for número vira `NaN`. */
function parseQuantity(text: string): number {
  return Number(text.trim().replace(',', '.'))
}

/** 2.5 → `"2,5"`: volta ao campo como o balcão escreve, sem separador de milhar. */
function quantityText(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 3, useGrouping: false })
}

/**
 * A quantidade da linha: menos, o número, mais.
 *
 * O passo é 1 em toda unidade; o fracionado (ml, g) se digita no meio. O menos para em
 * 1 — tirar o item é o X ao lado, e uma linha com zero seria venda de nada —, e o mais
 * para no saldo, que é onde o servidor recusaria de qualquer jeito. Digitado, o número
 * passa como veio: quem diz "não há saldo para tudo" continua sendo o servidor.
 */
function QuantityStepper({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: string
  max: number
  onChange: (quantity: string) => void
}) {
  const current = parseQuantity(value)
  const valid = Number.isFinite(current)

  function step(delta: number) {
    const base = valid ? current : 1
    const next = Math.min(Math.max(base + delta, 1), Math.max(max, 1))
    onChange(quantityText(next))
  }

  return (
    <div className="stepper shrink-0" role="group" aria-label={`Quantidade de ${label}`}>
      <button
        type="button"
        className="stepper-button"
        onClick={() => step(-1)}
        disabled={valid && current <= 1}
        aria-label={`Diminuir ${label}`}
      >
        <MinusIcon />
      </button>
      <input
        className="stepper-input"
        value={value}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => event.target.select()}
        aria-label={`Quantidade de ${label}`}
      />
      <button
        type="button"
        className="stepper-button"
        onClick={() => step(1)}
        disabled={valid && current + 1 > max}
        aria-label={`Aumentar ${label}`}
      >
        <PlusIcon />
      </button>
    </div>
  )
}
