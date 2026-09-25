'use client'

import { useEffect, useState, useTransition } from 'react'
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
import { AlertTriangleIcon, PackageIcon, WalletIcon, XIcon } from '@/components/icons'
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
      <Button icon={<WalletIcon />} onClick={() => setOpen(true)}>
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
          <Field label="Produto" htmlFor="sale-product">
            <select
              id="sale-product"
              className="field"
              value=""
              onChange={(event) => addProduct(event.target.value)}
              disabled={products === null}
            >
              <option value="">
                {products === null ? 'Carregando…' : 'Escolha um produto para incluir'}
              </option>
              {(products ?? []).map((product) => (
                <option
                  key={product.id}
                  value={product.id}
                  disabled={Number(product.quantityOnHand) <= 0}
                >
                  {product.name} · {formatBRL(product.salePriceCents ?? 0)} ·{' '}
                  {formatQuantity(product.quantityOnHand, product.unit)}
                </option>
              ))}
            </select>
          </Field>
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
                  <input
                    aria-label={`Quantidade de ${product.name}`}
                    className="field field-inline w-20 text-right"
                    value={line.quantity}
                    inputMode="decimal"
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, quantity: event.target.value } : item,
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
