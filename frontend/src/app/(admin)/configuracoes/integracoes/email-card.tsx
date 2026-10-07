'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { MessagingSettingsResponse } from '@petshop/shared-types'
import { Button, Card, Field, FormError, SectionHead } from '@/components/ui'
import { MailIcon } from '@/components/icons'
import { useToast } from '@/components/toast'
import { updateEmailSenderAction } from './actions'

/**
 * Como o e-mail ao tutor se apresenta: o nome no remetente e o endereço da resposta.
 *
 * Os dois campos moravam no fim de "Quando e quanto", nas configurações do
 * relacionamento, entre tetos de envio que nada têm a ver com eles. Aqui ficam ao lado do
 * que decide **de onde** o e-mail sai.
 */

interface Props {
  settings: MessagingSettingsResponse
  /** Sem `crm:configure` o cartão mostra o que está valendo, e não grava. */
  canEdit: boolean
}

export function EmailCard({ settings, canEdit }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [senderName, setSenderName] = useState(settings.senderName ?? '')
  const [replyToEmail, setReplyToEmail] = useState(settings.replyToEmail ?? '')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const changed =
    senderName.trim() !== (settings.senderName ?? '') ||
    replyToEmail.trim() !== (settings.replyToEmail ?? '')

  function save() {
    setError(null)
    setFieldErrors({})
    startTransition(async () => {
      const result = await updateEmailSenderAction({
        senderName: senderName.trim() || null,
        replyToEmail: replyToEmail.trim() || null,
      })
      if (!result.ok) {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      toast('Remetente salvo.')
      router.refresh()
    })
  }

  return (
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<MailIcon />}
        tone="icon-time"
        eyebrow="E-mail"
        title="Como o e-mail se apresenta"
        description="O nome que o tutor vê e para onde vai a resposta dele."
      />

      <FormError message={error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Nome do remetente"
          htmlFor="senderName"
          hint="Em branco, sai o nome do estabelecimento"
          error={fieldErrors.senderName}
        >
          <input
            id="senderName"
            className="field"
            maxLength={60}
            value={senderName}
            disabled={!canEdit || pending}
            onChange={(event) => setSenderName(event.target.value)}
          />
        </Field>

        <Field
          label="Responder para"
          htmlFor="replyToEmail"
          hint="Para onde vai a resposta do cliente"
          error={fieldErrors.replyToEmail}
        >
          <input
            id="replyToEmail"
            type="email"
            className="field"
            value={replyToEmail}
            disabled={!canEdit || pending}
            onChange={(event) => setReplyToEmail(event.target.value)}
          />
        </Field>
      </div>

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
