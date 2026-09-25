'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CASH_METHOD_LABELS,
  formatBRL,
  type SalePage,
  type SaleResponse,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import { Badge, Button, Field, FormError } from '@/components/ui'
import { PackageIcon } from '@/components/icons'
import { loadSalesAction, reverseSaleAction } from '../actions'
import { formatQuantity } from '../format'

/**
 * A lista das vendas, com o "Ver mais" e o estorno.
 *
 * Cada venda é um cartão de leitura: quando, para quem, o que saiu e quanto. O estorno
 * responde a **uma linha** e é `<Modal>` (regra 8 de `docs/design-formularios.md`).
 */
export function SalesList({ initial, canRefund }: { initial: SalePage; canRefund: boolean }) {
  const [items, setItems] = useState(initial.items)
  const [cursor, setCursor] = useState(initial.nextCursor)
  const [loading, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [reversing, setReversing] = useState<SaleResponse | null>(null)

  // Depois de um estorno ou de uma venda nova (`router.refresh`) a lista recomeça da
  // página do servidor, em vez de guardar a versão de antes.
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
      const response = await loadSalesAction(cursor)
      if (!response.ok) {
        setError(response.message)
        return
      }
      setItems((current) => [...current, ...response.data.items])
      setCursor(response.data.nextCursor)
    })
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {items.map((sale) => (
          <li key={sale.id} className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{sale.tutorName ?? 'Venda avulsa'}</p>
                <p className="hint mt-0.5">
                  {formatDateTime(sale.createdAt)}
                  {sale.createdByName && ` · ${sale.createdByName}`}
                  {/* MOD-CAIXA: a avulsa sempre tem forma; a do tutor, só quando pagou na hora. */}
                  {sale.paymentMethod &&
                    ` · ${sale.tutorId ? 'pago na hora, ' : ''}${CASH_METHOD_LABELS[sale.paymentMethod].toLowerCase()}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {sale.status === 'REVERSED' && <Badge>Estornada</Badge>}
                <span
                  className={`text-lg font-semibold tabular-nums ${
                    sale.status === 'REVERSED' ? 'text-subtle line-through' : ''
                  }`}
                >
                  {formatBRL(sale.totalCents)}
                </span>
              </div>
            </div>

            <ul className="mt-3 space-y-1 text-sm">
              {sale.items.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {item.label} · {formatQuantity(item.quantity, item.unit)}
                  </span>
                  <span className="tabular-nums text-muted">{formatBRL(item.totalPriceCents)}</span>
                </li>
              ))}
            </ul>

            {sale.status === 'REVERSED'
              ? sale.reversalReason && <p className="hint mt-3">Estorno: {sale.reversalReason}</p>
              : canRefund && (
                  <div className="mt-4 flex justify-end">
                    <Button className="h-9" onClick={() => setReversing(sale)}>
                      Estornar
                    </Button>
                  </div>
                )}
          </li>
        ))}
      </ul>

      {error && <FormError message={error} />}
      {cursor && (
        <div className="flex justify-center">
          <Button onClick={loadMore} busy={loading} busyLabel="Carregando…">
            Ver mais
          </Button>
        </div>
      )}

      {reversing && <ReverseDialog sale={reversing} onClose={() => setReversing(null)} />}
    </div>
  )
}

function ReverseDialog({ sale, onClose }: { sale: SaleResponse; onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      const response = await reverseSaleAction(sale.id, { reason })
      if (!response.ok) {
        setError({
          message: response.message,
          ...(response.fieldErrors.reason ? { field: response.fieldErrors.reason } : {}),
        })
        return
      }
      toast('Venda estornada.')
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
      eyebrow="Estornar venda"
      title={sale.tutorName ?? 'Venda avulsa'}
      subtitle={`${formatDateTime(sale.createdAt)} · ${formatBRL(sale.totalCents)}`}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Manter a venda
          </Button>
          <Button type="submit" form="reverse-form" busy={pending} busyLabel="Estornando…">
            Confirmar estorno
          </Button>
        </>
      }
    >
      <form id="reverse-form" onSubmit={submit} className="space-y-4" noValidate>
        {error && !error.field && <FormError message={error.message} />}
        <p className="text-sm text-muted">
          Os produtos voltam aos lotes de onde saíram
          {sale.tutorId ? ', e o débito sai da conta do tutor por contrapartida.' : '.'} A venda
          continua na lista, marcada como estornada.
        </p>
        <Field label="Motivo" htmlFor="reverse-reason" error={error?.field}>
          <input
            id="reverse-reason"
            className="field"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Cliente devolveu fechado"
            maxLength={200}
            autoFocus
          />
        </Field>
      </form>
    </Modal>
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
