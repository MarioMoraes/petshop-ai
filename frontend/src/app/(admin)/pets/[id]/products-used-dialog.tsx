'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  PRODUCT_UNIT_LABELS,
  type AttendanceItem,
  type ProductDetailResponse,
  type ProductUsed,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import { Button, Field, FormError } from '@/components/ui'
import { PawPrintIcon, XIcon } from '@/components/icons'
import { listSuppliesAction, updateProductsUsedAction, type ActionFailure } from '../actions'
import type { Attendance } from '@petshop/shared-types'

/**
 * Os produtos usados num serviço do atendimento (MOD-ESTOQUE-07, RN-11 do prontuário).
 *
 * É `<Modal>` porque responde a **uma linha** — um serviço do atendimento — e não à
 * ficha inteira. O que se grava aqui é também a baixa no estoque, pela diferença: tirar
 * uma vacina da lista devolve a dose ao lote.
 *
 * A linha antiga, só de texto, continua na lista e é mandada de volta como veio: ela não
 * mexe em estoque, e apagá-la calado apagaria o lote que alguém anotou à mão.
 */

interface LinkedLine {
  productId: string
  lotId: string
  quantity: string
}

function isLinked(line: ProductUsed): line is ProductUsed & LinkedLine {
  return Boolean(line.productId && line.lotId && line.quantity)
}

export function ProductsUsedDialog({
  petId,
  attendanceId,
  item,
  onClose,
  onSaved,
}: {
  petId: string
  attendanceId: string
  item: AttendanceItem
  onClose: () => void
  onSaved: (attendance: Attendance) => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  const [supplies, setSupplies] = useState<ProductDetailResponse[] | null>(null)
  useEffect(() => {
    void listSuppliesAction().then((response) => {
      if (response.ok) setSupplies(response.data.filter((product) => product.active))
      else setFailure(response)
    })
  }, [])

  const [textLines, setTextLines] = useState(item.productsUsed.filter((line) => !isLinked(line)))
  const [lines, setLines] = useState<LinkedLine[]>(
    item.productsUsed.filter(isLinked).map(({ productId, lotId, quantity }) => ({
      productId,
      lotId,
      quantity: quantity.replace('.', ','),
    })),
  )

  const byId = new Map((supplies ?? []).map((product) => [product.id, product]))

  function addProduct(productId: string) {
    const product = byId.get(productId)
    if (!product) return
    // O lote sugerido é o primeiro que não venceu: a lista já vem do que vence primeiro.
    const lot = product.lots.find((candidate) => !candidate.expired) ?? product.lots[0]
    if (!lot) return
    setLines((current) => [...current, { productId, lotId: lot.id, quantity: '1' }])
  }

  function update(index: number, patch: Partial<LinkedLine>) {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    )
  }

  function save() {
    setFailure(null)
    startTransition(async () => {
      const response = await updateProductsUsedAction(petId, attendanceId, item.id, [
        ...textLines,
        ...lines.map((line) => ({
          name: byId.get(line.productId)?.name ?? 'Produto',
          productId: line.productId,
          lotId: line.lotId,
          quantity: line.quantity,
        })),
      ])
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast('Produtos registrados.')
      onSaved(response.data)
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<PawPrintIcon />}
      tone="icon-pet"
      eyebrow="Produtos usados"
      title={item.label}
      subtitle="O lote fica no prontuário, e a dose sai do estoque."
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button busy={pending} busyLabel="Salvando…" onClick={save} disabled={supplies === null}>
            Salvar produtos
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {failure && <FormError message={failure.message} />}

        {textLines.length > 0 && (
          <ul className="space-y-1">
            {textLines.map((line, index) => (
              <li key={`${line.name}-${index}`} className="flex items-center justify-between gap-3">
                <span className="text-sm">
                  {line.name}
                  {line.batch && <span className="hint"> · lote {line.batch}</span>}
                  <span className="hint"> · anotado à mão</span>
                </span>
                <Button
                  variant="ghost"
                  className="h-9 w-9 px-0"
                  aria-label={`Tirar ${line.name}`}
                  onClick={() => setTextLines((current) => current.filter((_, i) => i !== index))}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {lines.length > 0 && (
          <ul className="divide-y divide-line">
            {lines.map((line, index) => {
              const product = byId.get(line.productId)
              return (
                <li key={`${line.productId}-${index}`} className="space-y-2 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{product?.name ?? 'Carregando…'}</p>
                    <Button
                      variant="ghost"
                      className="h-9 w-9 px-0"
                      aria-label={`Tirar ${product?.name ?? 'produto'}`}
                      onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                    <select
                      aria-label="Lote"
                      className="field"
                      value={line.lotId}
                      onChange={(event) => update(index, { lotId: event.target.value })}
                    >
                      {(product?.lots ?? []).map((lot) => (
                        <option
                          key={lot.id}
                          value={lot.id}
                          // Vacina vencida é recusada no servidor; aqui ela nem se escolhe.
                          disabled={lot.expired && product?.tracksExpiry}
                        >
                          {lot.batchCode === 'SEM-LOTE' ? 'Sem lote' : `Lote ${lot.batchCode}`}
                          {lot.expiresAt &&
                            ` · vence ${lot.expiresAt.split('-').reverse().join('/')}`}
                          {lot.expired && ' · vencido'}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Quantidade"
                      className="field text-right"
                      value={line.quantity}
                      inputMode="decimal"
                      onChange={(event) => update(index, { quantity: event.target.value })}
                    />
                  </div>
                  {product && <p className="hint">Em {PRODUCT_UNIT_LABELS[product.unit]}.</p>}
                </li>
              )
            })}
          </ul>
        )}

        <Field
          label="Incluir produto"
          htmlFor={`produto-${item.id}`}
          hint="Só insumos com lote cadastrado. A entrada de mercadoria fica em Estoque."
        >
          <select
            id={`produto-${item.id}`}
            className="field"
            value=""
            onChange={(event) => addProduct(event.target.value)}
            disabled={supplies === null}
          >
            <option value="">{supplies === null ? 'Carregando…' : 'Escolha o produto'}</option>
            {(supplies ?? [])
              .filter((product) => product.lots.length > 0)
              .map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
    </Modal>
  )
}
