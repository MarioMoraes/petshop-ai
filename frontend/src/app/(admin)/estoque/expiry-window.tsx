'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  INVENTORY_EXPIRY_WARNING_MAX_DAYS,
  INVENTORY_EXPIRY_WARNING_MIN_DAYS,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import { Button, Field, FormError } from '@/components/ui'
import { CalendarIcon } from '@/components/icons'
import { updateInventorySettingsAction, type ActionFailure } from './actions'

/**
 * A janela do alerta de validade, dita no próprio filtro "Vencendo" (MOD-ESTOQUE-09).
 *
 * A configuração mora onde o efeito dela aparece, e não numa aba de Configurações: quem
 * estranha "por que este lote está aqui?" lê a regra logo acima da lista, e quem pode
 * mudá-la muda ali mesmo. A faixa de abas do estabelecimento já está no limite.
 */
export function ExpiryWindow({ days, canEdit }: { days: number; canEdit: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="text-sm text-muted">
        Lotes com saldo e validade em até{' '}
        <span className="font-medium text-ink tabular-nums">
          {days} {days === 1 ? 'dia' : 'dias'}
        </span>
        , ou já vencidos.
      </p>
      {canEdit && (
        <Button className="h-9" icon={<CalendarIcon />} onClick={() => setOpen(true)}>
          Mudar o prazo
        </Button>
      )}
      {open && <ExpiryWindowDialog days={days} onClose={() => setOpen(false)} />}
    </div>
  )
}

function ExpiryWindowDialog({ days, onClose }: { days: number; onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState(String(days))
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    startTransition(async () => {
      const response = await updateInventorySettingsAction({
        expiryWarningDays: Number(value),
      })
      if (!response.ok) {
        setFailure(response)
        return
      }
      toast(`O alerta de validade agora olha ${response.data.expiryWarningDays} dias à frente.`)
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<CalendarIcon />}
      tone="icon-money"
      eyebrow="Estoque"
      title="Quando um lote está vencendo"
      subtitle="Vale para a lista, os selos dos produtos e o sino."
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="expiry-window-form" busy={pending} busyLabel="Salvando…">
            Salvar
          </Button>
        </>
      }
    >
      <form id="expiry-window-form" onSubmit={submit} className="space-y-5" noValidate>
        {failure && !failure.fieldErrors.expiryWarningDays && (
          <FormError message={failure.message} />
        )}
        <Field
          label="Avisar com quantos dias de antecedência"
          htmlFor="expiry-warning-days"
          error={failure?.fieldErrors.expiryWarningDays}
          hint={`De ${INVENTORY_EXPIRY_WARNING_MIN_DAYS} a ${INVENTORY_EXPIRY_WARNING_MAX_DAYS} dias. Vacina costuma pedir mais folga que ração.`}
        >
          <input
            id="expiry-warning-days"
            className="field tabular-nums"
            type="number"
            inputMode="numeric"
            min={INVENTORY_EXPIRY_WARNING_MIN_DAYS}
            max={INVENTORY_EXPIRY_WARNING_MAX_DAYS}
            step={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={pending}
          />
        </Field>
      </form>
    </Modal>
  )
}
