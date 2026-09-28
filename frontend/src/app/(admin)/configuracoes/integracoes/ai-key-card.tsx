'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentSettings } from '@petshop/shared-types'
import { Alert, Badge, Button, Card, Field, FormError, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, SparkleIcon } from '@/components/icons'
import { useToast } from '@/components/toast'
import { removeAgentApiKeyAction, saveAgentApiKeyAction } from './actions'

/**
 * A chave da Anthropic do estabelecimento.
 *
 * **Sem ela o agente não responde**: o consumo do modelo é do petshop, cobrado direto na
 * conta dele na Anthropic. A chave é conferida lá antes de gravar e nunca volta para a
 * tela — o cartão mostra só os quatro últimos caracteres, e trocar é colar outra.
 *
 * O campo é `type="password"` e começa vazio mesmo com chave cadastrada: preenchê-lo com
 * pontos fingiria um valor que o navegador não tem, e quem salvasse sem mexer gravaria os
 * pontos.
 */

interface Props {
  settings: AgentSettings
  /** `tenant:configure`. Sem ela o cartão só informa o estado. */
  canEdit: boolean
}

export function AiKeyCard({ settings, canEdit }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [saving, startSave] = useTransition()
  const [removing, startRemove] = useTransition()

  const key = settings.apiKey

  function save() {
    setError(null)
    setFieldError(undefined)
    startSave(async () => {
      const result = await saveAgentApiKeyAction(apiKey.trim())
      if (!result.ok) {
        setError(result.message)
        setFieldError(result.fieldErrors.apiKey)
        return
      }
      setApiKey('')
      toast('Chave da Anthropic salva.')
      router.refresh()
    })
  }

  function remove() {
    setError(null)
    startRemove(async () => {
      const result = await removeAgentApiKeyAction()
      if (!result.ok) {
        setError(result.message)
        return
      }
      setConfirmingRemove(false)
      toast('Chave removida.')
      router.refresh()
    })
  }

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHead
          icon={<SparkleIcon />}
          tone="icon-people"
          eyebrow="Assistente de IA"
          title="Chave da Anthropic"
          description="O agente que responde no WhatsApp usa a conta do petshop na Anthropic, e o consumo é cobrado direto nela. Sem chave, toda conversa vai para a fila da recepção."
        />
        <Badge tone={key?.error ? 'danger' : key ? 'success' : 'neutral'}>
          {key?.error ? 'Recusada' : key ? 'Conectada' : 'Sem chave'}
        </Badge>
      </div>

      {key?.error && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="A Anthropic recusou a chave">
          {key.error}. Confira no painel da Anthropic se a chave está ativa e se a conta tem
          crédito, e cadastre-a de novo abaixo.
        </Alert>
      )}

      {key && (
        <p className="text-sm">
          Chave terminada em <span className="font-mono font-medium">···{key.last4}</span>,
          conferida em {new Date(key.verifiedAt).toLocaleDateString('pt-BR')}.
        </p>
      )}

      <FormError message={error} />

      {canEdit ? (
        <>
          <Field
            label={key ? 'Trocar a chave' : 'Chave da API'}
            htmlFor="anthropicKey"
            hint="Gere em console.anthropic.com › API Keys. Começa com sk-ant-."
            error={fieldError}
          >
            <input
              id="anthropicKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="field font-mono"
              value={apiKey}
              disabled={saving || removing}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-ant-…"
            />
          </Field>

          {confirmingRemove ? (
            <Alert tone="danger" icon={<AlertTriangleIcon />} title="Remover a chave?">
              O agente para de responder na hora, e as conversas passam a ir todas para a fila.
              <span className="mt-3 flex flex-wrap gap-3">
                <Button type="button" busy={removing} onClick={remove} busyLabel="Removendo…">
                  Sim, remover
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={removing}
                  onClick={() => setConfirmingRemove(false)}
                >
                  Cancelar
                </Button>
              </span>
            </Alert>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                busy={saving}
                disabled={apiKey.trim() === '' || removing}
                onClick={save}
                busyLabel="Conferindo…"
              >
                {key ? 'Trocar chave' : 'Salvar chave'}
              </Button>
              {key && (
                <Button type="button" disabled={saving} onClick={() => setConfirmingRemove(true)}>
                  Remover
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          Cadastrar a chave da Anthropic é uma ação do administrador do estabelecimento.
        </p>
      )}
    </Card>
  )
}
