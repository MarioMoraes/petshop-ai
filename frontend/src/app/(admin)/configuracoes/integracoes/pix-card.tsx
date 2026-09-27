'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { BillingSettings } from '@petshop/shared-types'
import { Button, Card, Field, FormError, SectionHead } from '@/components/ui'
import { WalletIcon } from '@/components/icons'
import { useToast } from '@/components/toast'
import { updatePixKeyAction } from './actions'

/**
 * A chave PIX que o Portal do Tutor exibe (AC-05 de MOD-PORTAL-08).
 *
 * O cliente que abre "Minha conta" e vê um saldo devedor encontra esta chave, o telefone
 * público e o horário de atendimento.
 *
 * Veio de Financeiro › Políticas, e o cartão continua separado da lista de "Formas de
 * pagamento aceitas": aquela lista decide o que o **balcão** pode registrar; esta chave é
 * o que o **cliente** lê. Ligar PIX na lista e deixar a chave vazia é situação legítima —
 * o petshop que só recebe PIX presencialmente, pelo aparelho do caixa.
 */

interface Props {
  settings: BillingSettings
  /** `finance:configure`. */
  canEdit: boolean
}

export function PixCard({ settings, canEdit }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [pixKey, setPixKey] = useState(settings.pixKey ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const next = pixKey.trim() === '' ? null : pixKey.trim()
  const changed = next !== (settings.pixKey ?? null)

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await updatePixKeyAction(next)
      if (!result.ok) {
        setError(result.message)
        return
      }
      toast(next ? 'Chave PIX salva.' : 'Chave PIX removida.')
      router.refresh()
    })
  }

  return (
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<WalletIcon />}
        tone="icon-system"
        eyebrow="Cobrança"
        title="Chave PIX no Portal do Tutor"
        description="Aparece para o cliente que tem valor em aberto, junto do telefone e do horário de atendimento. Em branco, o Portal mostra só o contato."
      />

      <FormError message={error} />

      <Field
        label="Chave PIX"
        htmlFor="pix"
        hint="CPF, CNPJ, telefone, e-mail ou chave aleatória. Confira antes de salvar: o cliente copia daqui."
      >
        <input
          id="pix"
          className="field"
          value={pixKey}
          disabled={!canEdit || pending}
          onChange={(event) => setPixKey(event.target.value)}
          placeholder="Sem chave PIX"
        />
      </Field>

      {canEdit && (
        <div>
          <Button
            type="button"
            busy={pending}
            disabled={!changed}
            onClick={save}
            busyLabel="Salvando…"
          >
            Salvar
          </Button>
        </div>
      )}
    </Card>
  )
}
