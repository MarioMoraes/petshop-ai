'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  STOCK_MOVEMENT_LABELS,
  formatBRL,
  parseBRLToCents,
  type LotTrace,
  type ProductDetailResponse,
  type ProductUnit,
  type StockLotResponse,
  type StockMovementPage,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import { Badge, Button, CardHead, Choice, Field, FormError, Segmented } from '@/components/ui'
import { NoteIcon, PackageIcon, UploadIcon } from '@/components/icons'
import {
  adjustStockAction,
  deleteProductAction,
  loadMovementsAction,
  registerEntryAction,
  registerInternalUseAction,
  traceLotAction,
  type ActionFailure,
} from '../actions'
import { formatExpiry, formatQuantity, newIdempotencyKey } from '../format'

/**
 * As partes da ficha do produto que respondem a clique.
 *
 * Entrada e ajuste são `<Modal>` (regra 8 de `docs/design-formularios.md`): a entrada
 * responde ao produto e o ajuste a **uma linha** da tabela de lotes. A chave de
 * idempotência nasce quando a janela abre, e é ela que faz o duplo clique no Salvar
 * gravar uma vez só.
 */

// ─── Entrada de mercadoria (MOD-ESTOQUE-03) ──────────────────────────────────

const UNIT_WORDS: Record<ProductUnit, string> = {
  UN: 'unidades',
  ML: 'ml',
  L: 'litros',
  G: 'gramas',
  KG: 'kg',
}

export function EntryButton({ product }: { product: ProductDetailResponse }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon={<UploadIcon />} onClick={() => setOpen(true)} disabled={!product.active}>
        Dar entrada
      </Button>
      {open && <EntryDialog product={product} onClose={() => setOpen(false)} />}
    </>
  )
}

function EntryDialog({
  product,
  onClose,
}: {
  product: ProductDetailResponse
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [idempotencyKey] = useState(newIdempotencyKey)

  const [batchCode, setBatchCode] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [costError, setCostError] = useState<string | null>(null)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)

    const unitCostCents = unitCost.trim() ? parseBRLToCents(unitCost) : null
    if (unitCost.trim() && unitCostCents === null) {
      setCostError('Informe o custo no formato 12,50')
      return
    }
    setCostError(null)

    startTransition(async () => {
      const response = await registerEntryAction({
        productId: product.id,
        batchCode: batchCode.trim() || null,
        expiresAt: expiresAt || null,
        quantity,
        unitCostCents,
        idempotencyKey,
      })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast('Entrada registrada.')
      onClose()
      router.refresh()
    })
  }

  const errors = failure?.fieldErrors ?? {}

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PackageIcon />}
      tone="icon-money"
      eyebrow="Entrada de mercadoria"
      title={product.name}
      subtitle={`Saldo atual: ${formatQuantity(product.quantityOnHand, product.unit)}`}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="entry-form" busy={pending} busyLabel="Registrando…">
            Registrar entrada
          </Button>
        </>
      }
    >
      <form id="entry-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure && Object.keys(failure.fieldErrors).length === 0 && (
          <FormError message={failure.message} />
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Quantidade"
            htmlFor="entry-quantity"
            error={errors.quantity}
            hint={`Em ${UNIT_WORDS[product.unit]}.`}
          >
            <input
              id="entry-quantity"
              className="field"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              inputMode="decimal"
              autoFocus
            />
          </Field>
          <Field
            label="Custo unitário (R$)"
            htmlFor="entry-cost"
            error={costError ?? errors.unitCostCents}
            hint="Opcional. O da nota."
          >
            <input
              id="entry-cost"
              className="field"
              value={unitCost}
              onChange={(event) => setUnitCost(event.target.value)}
              inputMode="decimal"
              placeholder="0,00"
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Lote"
            htmlFor="entry-batch"
            error={errors.batchCode}
            hint={product.tracksExpiry ? 'O código impresso na caixa.' : 'Opcional.'}
          >
            <input
              id="entry-batch"
              className="field uppercase"
              value={batchCode}
              onChange={(event) => setBatchCode(event.target.value)}
              maxLength={40}
            />
          </Field>
          <Field
            label={product.tracksExpiry ? 'Validade' : 'Validade (opcional)'}
            htmlFor="entry-expiry"
            error={errors.expiresAt}
          >
            <input
              id="entry-expiry"
              type="date"
              className="field"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

// ─── Lotes e ajuste (MOD-ESTOQUE-02/04) ──────────────────────────────────────

export function LotsCard({
  product,
  canWrite,
  canTrace,
}: {
  product: ProductDetailResponse
  canWrite: boolean
  /** `inventory:read` + `record:read_summary`: o rastreio lista pets e tutores. */
  canTrace: boolean
}) {
  const [adjusting, setAdjusting] = useState<StockLotResponse | null>(null)
  const [tracing, setTracing] = useState<StockLotResponse | null>(null)

  return (
    <section className="card p-6">
      <CardHead
        icon={<PackageIcon />}
        tone="icon-money"
        title="Lotes"
        description={
          product.tracksExpiry
            ? 'O que vence primeiro aparece primeiro — é o que deve sair primeiro.'
            : undefined
        }
      />

      {product.lots.length === 0 ? (
        // Frase e não a peça de estado vazio: ela é um cartão, e cartão dentro de
        // cartão desenha uma borda a mais onde só falta uma linha.
        <p className="hint mt-4">
          Nenhum lote ainda. O saldo nasce na primeira entrada de mercadoria.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="data-table data-table-flush min-w-[34rem]">
            <thead>
              <tr>
                <th>Lote</th>
                <th>Validade</th>
                <th className="text-right">Saldo</th>
                <th className="text-right">Custo unit.</th>
                {(canWrite || canTrace) && <th aria-label="Ações" />}
              </tr>
            </thead>
            <tbody>
              {product.lots.map((lot) => (
                <tr key={lot.id}>
                  <td className="font-medium">
                    {lot.batchCode === 'SEM-LOTE' ? 'Sem lote' : lot.batchCode}
                  </td>
                  <td>
                    <span className="inline-flex flex-wrap items-center gap-2 tabular-nums">
                      {lot.expiresAt ? formatExpiry(lot.expiresAt) : '—'}
                      {lot.expired && <Badge tone="danger">Vencido</Badge>}
                      {lot.expiring && <Badge tone="accent">Vencendo</Badge>}
                    </span>
                  </td>
                  <td
                    className={`text-right tabular-nums ${
                      Number(lot.quantityOnHand) < 0 ? 'text-danger' : ''
                    }`}
                  >
                    {formatQuantity(lot.quantityOnHand, product.unit)}
                  </td>
                  <td className="text-right tabular-nums">
                    {lot.unitCostCents === null ? '—' : formatBRL(lot.unitCostCents)}
                  </td>
                  {(canWrite || canTrace) && (
                    <td className="text-right">
                      <span className="inline-flex gap-2">
                        {canTrace && (
                          <Button className="h-9" onClick={() => setTracing(lot)}>
                            Quem recebeu
                          </Button>
                        )}
                        {canWrite && (
                          <Button className="h-9" onClick={() => setAdjusting(lot)}>
                            Ajustar
                          </Button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adjusting && (
        <AdjustDialog product={product} lot={adjusting} onClose={() => setAdjusting(null)} />
      )}
      {tracing && <TraceDialog product={product} lot={tracing} onClose={() => setTracing(null)} />}
    </section>
  )
}

type AdjustMode = 'COUNT' | 'DELTA'

const MODE_OPTIONS: readonly { value: AdjustMode; label: string }[] = [
  { value: 'COUNT', label: 'Contei o lote' },
  { value: 'DELTA', label: 'Corrigir uma diferença' },
]

function AdjustDialog({
  product,
  lot,
  onClose,
}: {
  product: ProductDetailResponse
  lot: StockLotResponse
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [idempotencyKey] = useState(newIdempotencyKey)

  const [mode, setMode] = useState<AdjustMode>('COUNT')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [isLoss, setIsLoss] = useState(lot.expired)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    startTransition(async () => {
      const response = await adjustStockAction(product.id, {
        lotId: lot.id,
        type: isLoss ? 'LOSS' : 'ADJUSTMENT',
        mode,
        quantity,
        reason,
        idempotencyKey,
      })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast(isLoss ? 'Perda registrada.' : 'Estoque ajustado.')
      onClose()
      router.refresh()
    })
  }

  const errors = failure?.fieldErrors ?? {}
  const lotLabel = lot.batchCode === 'SEM-LOTE' ? 'sem lote' : `lote ${lot.batchCode}`

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PackageIcon />}
      tone="icon-money"
      eyebrow="Ajuste de estoque"
      title={product.name}
      subtitle={`${lotLabel} · saldo registrado: ${formatQuantity(lot.quantityOnHand, product.unit)}`}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="adjust-form" busy={pending} busyLabel="Gravando…">
            {isLoss ? 'Registrar perda' : 'Gravar ajuste'}
          </Button>
        </>
      }
    >
      <form id="adjust-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure && Object.keys(failure.fieldErrors).length === 0 && (
          <FormError message={failure.message} />
        )}

        <Segmented
          ariaLabel="Tipo de ajuste"
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
        />

        <Field
          label={mode === 'COUNT' ? 'Quantos há na prateleira' : 'Diferença'}
          htmlFor="adjust-quantity"
          error={errors.quantity}
          hint={
            mode === 'COUNT'
              ? 'O sistema calcula a diferença contra o saldo registrado.'
              : 'Negativo tira, positivo põe. Ex.: -1 para um frasco quebrado.'
          }
        >
          <input
            id="adjust-quantity"
            className="field"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            inputMode="decimal"
            autoFocus
          />
        </Field>

        <Field label="Motivo" htmlFor="adjust-reason" error={errors.reason}>
          <input
            id="adjust-reason"
            className="field"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={isLoss ? 'Vencido, quebrado, extraviado…' : 'Contagem de fim de mês'}
            maxLength={200}
          />
        </Field>

        <Choice
          label="É uma perda"
          description="Vencimento, quebra ou extravio. Aparece separado do ajuste de contagem no histórico."
          checked={isLoss}
          onChange={setIsLoss}
        />
      </form>
    </Modal>
  )
}

// ─── Histórico ───────────────────────────────────────────────────────────────

export function MovementsCard({
  product,
  initial,
}: {
  product: ProductDetailResponse
  initial: StockMovementPage
}) {
  const [items, setItems] = useState(initial.items)
  const [cursor, setCursor] = useState(initial.nextCursor)
  const [loading, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // A página do servidor muda depois de uma entrada ou ajuste (`router.refresh`): a
  // lista recomeça dela, em vez de guardar a versão de antes do movimento.
  const [seen, setSeen] = useState(initial)
  if (seen !== initial) {
    setSeen(initial)
    setItems(initial.items)
    setCursor(initial.nextCursor)
  }

  function loadMore() {
    if (!cursor) return
    setError(null)
    startTransition(async () => {
      const response = await loadMovementsAction(product.id, cursor)
      if (!response.ok) {
        setError(response.message)
        return
      }
      setItems((current) => [...current, ...response.data.items])
      setCursor(response.data.nextCursor)
    })
  }

  return (
    <section className="card p-6">
      <CardHead icon={<NoteIcon />} tone="icon-money" title="Histórico" />

      {items.length === 0 ? (
        <p className="hint mt-4">
          Nenhum movimento ainda. Entradas, ajustes e perdas aparecem aqui, do mais novo para o mais
          antigo.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="data-table data-table-flush min-w-[40rem]">
            <thead>
              <tr>
                <th>Quando</th>
                <th>O quê</th>
                <th>Lote</th>
                <th className="text-right">Quantidade</th>
                <th className="text-right">Saldo do lote</th>
              </tr>
            </thead>
            <tbody>
              {items.map((movement) => {
                const value = Number(movement.quantity)
                return (
                  <tr key={movement.id}>
                    <td className="tabular-nums">{formatDateTime(movement.occurredAt)}</td>
                    <td>
                      <span className="font-medium">{STOCK_MOVEMENT_LABELS[movement.type]}</span>
                      {(movement.reason || movement.createdByName) && (
                        <span className="hint block">
                          {[movement.reason, movement.createdByName].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </td>
                    <td>{movement.batchCode === 'SEM-LOTE' ? '—' : movement.batchCode}</td>
                    <td
                      className={`text-right font-medium tabular-nums ${
                        value < 0 ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {value > 0 ? '+' : ''}
                      {formatQuantity(movement.quantity, product.unit)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatQuantity(movement.quantityAfter, product.unit)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <FormError message={error} />
        </div>
      )}
      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button onClick={loadMore} busy={loading} busyLabel="Carregando…">
            Ver mais
          </Button>
        </div>
      )}
    </section>
  )
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ─── Exclusão (AC-03) ────────────────────────────────────────────────────────

/**
 * Só aparece para o produto que nunca se moveu. É link sublinhado no pé da ficha, e não
 * botão ao lado de Editar, pela mesma razão do rodapé do diálogo: destrutivo não fica a
 * um deslize da ação mais clicada.
 */
export function DeleteProductLink({ product }: { product: ProductDetailResponse }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function confirm() {
    setError(null)
    startTransition(async () => {
      const response = await deleteProductAction(product.id)
      if (!response.ok) {
        setError(response.message)
        return
      }
      toast('Produto excluído.')
      router.push('/estoque')
    })
  }

  return (
    <>
      <button
        type="button"
        className="text-sm text-danger underline decoration-danger/40 underline-offset-4 hover:decoration-danger"
        onClick={() => setOpen(true)}
      >
        Excluir produto
      </button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          icon={<PackageIcon />}
          tone="icon-money"
          eyebrow="Excluir produto"
          title={product.name}
          subtitle="Ele nunca teve movimento, então sai sem deixar histórico."
          busy={pending}
          footer={
            <>
              <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                Manter o produto
              </Button>
              <Button busy={pending} busyLabel="Excluindo…" onClick={confirm}>
                Confirmar exclusão
              </Button>
            </>
          }
        >
          {error ? (
            <FormError message={error} />
          ) : (
            <p className="text-sm text-muted">
              O SKU volta a ficar livre para outro produto. Se a ideia é só tirar da lista, desative
              em Editar.
            </p>
          )}
        </Modal>
      )}
    </>
  )
}

// ─── Uso interno (MOD-ESTOQUE-08) ────────────────────────────────────────────

/** O shampoo que acabou no banho: sai por FEFO, sem pet, pela equipe que atende. */
export function InternalUseButton({ product }: { product: ProductDetailResponse }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!product.active}>
        Registrar uso
      </Button>
      {open && <InternalUseDialog product={product} onClose={() => setOpen(false)} />}
    </>
  )
}

function InternalUseDialog({
  product,
  onClose,
}: {
  product: ProductDetailResponse
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [idempotencyKey] = useState(newIdempotencyKey)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    startTransition(async () => {
      const response = await registerInternalUseAction({
        productId: product.id,
        quantity,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        idempotencyKey,
      })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast('Uso registrado.')
      onClose()
      router.refresh()
    })
  }

  const errors = failure?.fieldErrors ?? {}

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PackageIcon />}
      tone="icon-money"
      eyebrow="Uso interno"
      title={product.name}
      subtitle={`Saldo atual: ${formatQuantity(product.quantityOnHand, product.unit)}`}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="use-form" busy={pending} busyLabel="Registrando…">
            Registrar uso
          </Button>
        </>
      }
    >
      <form id="use-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure && Object.keys(failure.fieldErrors).length === 0 && (
          <FormError message={failure.message} />
        )}
        <Field
          label="Quanto foi usado"
          htmlFor="use-quantity"
          error={errors.quantity}
          hint={`Em ${UNIT_WORDS[product.unit]}. Sai do lote que vence primeiro.`}
        >
          <input
            id="use-quantity"
            className="field"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            inputMode="decimal"
            autoFocus
          />
        </Field>
        <Field label="Observação (opcional)" htmlFor="use-reason" error={errors.reason}>
          <input
            id="use-reason"
            className="field"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Banhos da manhã"
            maxLength={200}
          />
        </Field>
      </form>
    </Modal>
  )
}

// ─── Quem recebeu o lote (MOD-ESTOQUE-10) ────────────────────────────────────

/**
 * O fabricante recolheu o lote: quais pets o receberam? A lista leva à ficha do pet, e
 * a devolução (venda estornada, atendimento anulado) aparece com o sinal trocado.
 */
function TraceDialog({
  product,
  lot,
  onClose,
}: {
  product: ProductDetailResponse
  lot: StockLotResponse
  onClose: () => void
}) {
  const [trace, setTrace] = useState<LotTrace | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void traceLotAction(lot.id).then((response) => {
      if (response.ok) setTrace(response.data)
      else setError(response.message)
    })
  }, [lot.id])

  const lotLabel = lot.batchCode === 'SEM-LOTE' ? 'Sem lote' : `Lote ${lot.batchCode}`

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PackageIcon />}
      tone="icon-money"
      eyebrow="Quem recebeu"
      title={`${product.name} · ${lotLabel}`}
      subtitle={lot.expiresAt ? `Validade ${formatExpiry(lot.expiresAt)}` : undefined}
      footer={<Button onClick={onClose}>Fechar</Button>}
    >
      {error ? (
        <FormError message={error} />
      ) : trace === null ? (
        <p className="hint">Carregando…</p>
      ) : trace.entries.length === 0 ? (
        <p className="hint">Nenhum pet recebeu este lote, e ninguém o comprou.</p>
      ) : (
        <ul className="divide-y divide-line">
          {trace.entries.map((entry) => {
            const value = Number(entry.quantity)
            return (
              <li key={entry.movementId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  {entry.petId ? (
                    <Link
                      href={`/pets/${entry.petId}`}
                      className="font-medium underline decoration-line underline-offset-4 hover:decoration-ink"
                    >
                      {entry.petName ?? 'Pet'}
                    </Link>
                  ) : (
                    <span className="font-medium">{entry.tutorName ?? 'Venda'}</span>
                  )}
                  <p className="hint">
                    {[
                      STOCK_MOVEMENT_LABELS[entry.type],
                      entry.petId ? entry.tutorName : null,
                      new Date(entry.occurredAt).toLocaleDateString('pt-BR'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <span className={`tabular-nums ${value < 0 ? 'text-subtle' : 'font-medium'}`}>
                  {value < 0 ? 'devolveu ' : ''}
                  {formatQuantity(String(Math.abs(value)), trace.unit)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
