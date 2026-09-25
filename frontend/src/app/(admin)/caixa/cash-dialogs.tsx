'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CASH_METHOD_LABELS,
  formatBRL,
  formatCentsInput,
  parseBRLToCents,
  type CashMethod,
  type CashMethodTotal,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import { Alert, Button, Field, FormError, Segmented } from '@/components/ui'
import { AlertTriangleIcon, BanknoteIcon } from '@/components/icons'
import {
  adjustCashAction,
  closeCashAction,
  openCashAction,
  type ActionFailure,
} from './actions'

/**
 * Os três diálogos do caixa do dia: abrir, sangria/suprimento e fechar.
 *
 * Todos em `<Modal>`, no tom do dinheiro. O dinheiro é digitado como o balcão digita —
 * "150", "150,00", "R$ 150" — e vira centavos na borda, como no pagamento do Financeiro.
 */

// ─── Abrir ───────────────────────────────────────────────────────────────────

export function OpenCashButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon={<BanknoteIcon />} onClick={() => setOpen(true)}>
        Abrir caixa
      </Button>
      {open && <OpenCashDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function OpenCashDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [amount, setAmount] = useState('')
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const cents = amount.trim() ? parseBRLToCents(amount) : 0
    if (cents === null || cents < 0) {
      setFailure({ ok: false, message: '', fieldErrors: { openingFloatCents: 'Valor inválido' } })
      return
    }
    setFailure(null)
    startTransition(async () => {
      const response = await openCashAction({ openingFloatCents: cents })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast(cents > 0 ? `Caixa aberto com ${formatBRL(cents)} de troco.` : 'Caixa aberto.')
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<BanknoteIcon />}
      tone="icon-money"
      eyebrow="Caixa do dia"
      title="Abrir o caixa"
      subtitle="Conte o dinheiro que já está na gaveta antes de começar."
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="cash-open-form" busy={pending} busyLabel="Abrindo…">
            Abrir caixa
          </Button>
        </>
      }
    >
      <form id="cash-open-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure?.message && <FormError message={failure.message} />}
        <MoneyField
          id="cash-open-float"
          label="Troco inicial"
          value={amount}
          onChange={setAmount}
          disabled={pending}
          hint="Em branco é abrir com a gaveta vazia."
          error={failure?.fieldErrors.openingFloatCents}
        />
      </form>
    </Modal>
  )
}

// ─── Sangria e suprimento ────────────────────────────────────────────────────

type AdjustmentType = 'WITHDRAWAL' | 'DEPOSIT'

const ADJUSTMENT_OPTIONS: readonly { value: AdjustmentType; label: string }[] = [
  { value: 'WITHDRAWAL', label: 'Sangria' },
  { value: 'DEPOSIT', label: 'Suprimento' },
]

export function AdjustCashButton({ cashInDrawerCents }: { cashInDrawerCents: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Sangria ou suprimento</Button>
      {open && (
        <AdjustCashDialog cashInDrawerCents={cashInDrawerCents} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function AdjustCashDialog({
  cashInDrawerCents,
  onClose,
}: {
  cashInDrawerCents: number
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [type, setType] = useState<AdjustmentType>('WITHDRAWAL')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const cents = parseBRLToCents(amount)
    if (!cents || cents <= 0) {
      setFailure({ ok: false, message: '', fieldErrors: { amountCents: 'Informe o valor' } })
      return
    }
    setFailure(null)
    startTransition(async () => {
      const response = await adjustCashAction({ type, amountCents: cents, reason })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast(
        type === 'WITHDRAWAL'
          ? `Sangria de ${formatBRL(cents)} registrada.`
          : `Suprimento de ${formatBRL(cents)} registrado.`,
      )
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<BanknoteIcon />}
      tone="icon-money"
      eyebrow="Caixa do dia"
      title={type === 'WITHDRAWAL' ? 'Tirar dinheiro da gaveta' : 'Pôr dinheiro na gaveta'}
      subtitle={`Há ${formatBRL(cashInDrawerCents)} em dinheiro na gaveta agora.`}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="cash-adjust-form" busy={pending} busyLabel="Registrando…">
            Registrar
          </Button>
        </>
      }
    >
      <form id="cash-adjust-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure?.message && !failure.fieldErrors.amountCents && (
          <FormError message={failure.message} />
        )}
        <Segmented
          options={ADJUSTMENT_OPTIONS}
          value={type}
          onChange={setType}
          disabled={pending}
          ariaLabel="Tipo de movimento"
        />
        <MoneyField
          id="cash-adjust-amount"
          label="Valor"
          value={amount}
          onChange={setAmount}
          disabled={pending}
          error={failure?.fieldErrors.amountCents}
          hint={
            type === 'WITHDRAWAL'
              ? 'O dinheiro que vai para o cofre ou para o banco.'
              : 'O dinheiro que entra para dar troco.'
          }
        />
        <Field label="Motivo" htmlFor="cash-adjust-reason" error={failure?.fieldErrors.reason}>
          <input
            id="cash-adjust-reason"
            className="field"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
            placeholder={type === 'WITHDRAWAL' ? 'Depósito no banco' : 'Troco do cofre'}
          />
        </Field>
      </form>
    </Modal>
  )
}

// ─── Fechar ──────────────────────────────────────────────────────────────────

export function CloseCashButton({
  sessionId,
  byMethod,
}: {
  sessionId: string
  byMethod: CashMethodTotal[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Fechar caixa</Button>
      {open && (
        <CloseCashDialog
          sessionId={sessionId}
          byMethod={byMethod}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * O fechamento: uma linha por forma, com o esperado ao lado do campo.
 *
 * O dinheiro é obrigatório. As outras formas podem ficar em branco — quem não confere a
 * maquininha na hora deixa sem contagem, e ela não entra na diferença. A diferença é
 * calculada enquanto se digita, e quando existe o campo de justificativa aparece e
 * passa a ser exigido: é a mesma regra do servidor, dita antes do clique.
 */
function CloseCashDialog({
  sessionId,
  byMethod,
  onClose,
}: {
  sessionId: string
  byMethod: CashMethodTotal[]
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [counted, setCounted] = useState<Partial<Record<CashMethod, string>>>({})
  const [notes, setNotes] = useState('')
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  const rows = byMethod.map((row) => {
    const text = counted[row.method] ?? ''
    const cents = text.trim() ? parseBRLToCents(text) : null
    return { ...row, text, cents }
  })
  const cashRow = rows.find((row) => row.method === 'CASH')
  const invalid = rows.some((row) => row.text.trim() && row.cents === null)
  const difference = rows.reduce(
    (sum, row) => (row.cents === null ? sum : sum + row.cents - row.expectedCents),
    0,
  )

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!cashRow || cashRow.cents === null || invalid) {
      setFailure({
        ok: false,
        message: '',
        fieldErrors: { CASH: 'Conte o dinheiro da gaveta' },
      })
      return
    }
    setFailure(null)
    startTransition(async () => {
      const response = await closeCashAction(sessionId, {
        counts: rows
          .filter((row) => row.cents !== null)
          .map((row) => ({ method: row.method, countedCents: row.cents as number })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      if (!response.ok) {
        setFailure(response)
        return
      }
      const diff = response.data.differenceCents ?? 0
      toast(
        diff === 0
          ? 'Caixa fechado sem diferença.'
          : `Caixa fechado com ${diff > 0 ? 'sobra' : 'falta'} de ${formatBRL(Math.abs(diff))}.`,
      )
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<BanknoteIcon />}
      tone="icon-money"
      eyebrow="Caixa do dia"
      title="Fechar o caixa"
      subtitle="Conte a gaveta e confira o que puder da maquininha e do PIX."
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="cash-close-form" busy={pending} busyLabel="Fechando…">
            Fechar caixa
          </Button>
        </>
      }
    >
      <form id="cash-close-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure?.message && failure.code !== 'ERR_CASH_006' && (
          <FormError message={failure.message} />
        )}

        {rows.map((row) => (
          <MoneyField
            key={row.method}
            id={`cash-close-${row.method}`}
            label={`${CASH_METHOD_LABELS[row.method]} contado`}
            value={row.text}
            onChange={(value) => setCounted((current) => ({ ...current, [row.method]: value }))}
            disabled={pending}
            error={failure?.fieldErrors[row.method]}
            hint={
              row.method === 'CASH'
                ? `Esperado ${formatBRL(row.expectedCents)} na gaveta.`
                : `Esperado ${formatBRL(row.expectedCents)}. Em branco fica sem conferência.`
            }
            placeholder={formatCentsInput(row.expectedCents)}
          />
        ))}

        {difference !== 0 && !invalid && cashRow?.cents !== null && (
          <Alert
            tone="accent"
            icon={<AlertTriangleIcon />}
            title={
              difference > 0
                ? `Sobram ${formatBRL(difference)}`
                : `Faltam ${formatBRL(-difference)}`
            }
          >
            <Field
              label="O que aconteceu"
              htmlFor="cash-close-notes"
              error={failure?.code === 'ERR_CASH_006' ? failure.message : undefined}
            >
              <textarea
                id="cash-close-notes"
                className="field min-h-20"
                value={notes}
                maxLength={500}
                onChange={(event) => setNotes(event.target.value)}
                disabled={pending}
                placeholder="Troco dado a mais, venda não registrada…"
              />
            </Field>
          </Alert>
        )}
      </form>
    </Modal>
  )
}

// ─── Peças ───────────────────────────────────────────────────────────────────

/**
 * O campo de dinheiro do balcão: a string é o estado, e a conversão para centavos
 * acontece no envio — forçar a máscara a cada tecla faria o cursor pular.
 */
function MoneyField({
  id,
  label,
  value,
  onChange,
  disabled,
  error,
  hint,
  placeholder = '0,00',
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  error?: string | undefined
  hint?: string
  placeholder?: string
}) {
  return (
    <Field label={label} htmlFor={id} {...(error ? { error } : {})} {...(hint ? { hint } : {})}>
      <div className="field-wrap">
        <span className="field-lead text-sm">R$</span>
        <input
          id={id}
          className="field tabular-nums"
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
        />
      </div>
    </Field>
  )
}
