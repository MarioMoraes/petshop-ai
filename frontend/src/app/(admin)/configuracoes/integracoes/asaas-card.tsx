'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ASAAS_ENVIRONMENTS,
  ASAAS_ENVIRONMENT_LABELS,
  type AsaasEnvironment,
  type OnlineBilling,
} from '@petshop/shared-types'
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  FormError,
  SectionHead,
  Segmented,
} from '@/components/ui'
import { AlertTriangleIcon, BanknoteIcon } from '@/components/icons'
import { useToast } from '@/components/toast'
import { connectOnlineBillingAction, disconnectOnlineBillingAction } from './actions'

/**
 * A conta do Asaas do petshop — a cobrança online do tutor.
 *
 * Com ela conectada, o tutor que deve vê "Pagar agora" no Portal e no app, e a recepção
 * gera um link de pagamento na conta dele. O tutor paga por PIX ou cartão na página do
 * Asaas, o dinheiro cai na conta do petshop, e a baixa entra sozinha — com recibo, como a
 * de balcão.
 *
 * Conectar confere a chave no ambiente escolhido e cadastra, na conta do petshop, o aviso
 * que dá a baixa. Por isso o ambiente vem antes da chave: a de teste só vale no sandbox, e
 * errar o par é o motivo mais comum de "chave recusada".
 */

interface Props {
  connection: OnlineBilling
  /** `tenant:configure`. Sem ela o cartão só informa. */
  canEdit: boolean
}

export function AsaasCard({ connection, canEdit }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [environment, setEnvironment] = useState<AsaasEnvironment>(
    connection?.environment ?? 'PRODUCTION',
  )
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [saving, startSave] = useTransition()
  const [removing, startRemove] = useTransition()

  function connect() {
    setError(null)
    setFieldError(undefined)
    startSave(async () => {
      const result = await connectOnlineBillingAction({ apiKey: apiKey.trim(), environment })
      if (!result.ok) {
        setError(result.message)
        setFieldError(result.fieldErrors.apiKey)
        return
      }
      setApiKey('')
      toast('Asaas conectado.')
      router.refresh()
    })
  }

  function disconnect() {
    setError(null)
    startRemove(async () => {
      const result = await disconnectOnlineBillingAction()
      if (!result.ok) {
        setError(result.message)
        return
      }
      setConfirmingRemove(false)
      toast('Asaas desconectado.')
      router.refresh()
    })
  }

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHead
          icon={<BanknoteIcon />}
          tone="icon-system"
          eyebrow="Cobrança"
          title="Pagamento online pelo Asaas"
          description="O tutor paga por PIX ou cartão num link, o dinheiro cai na conta do petshop no Asaas e a baixa na conta dele é automática, com recibo."
        />
        <Badge tone={connection?.error ? 'danger' : connection ? 'success' : 'neutral'}>
          {connection?.error ? 'Chave recusada' : connection ? 'Conectado' : 'Não conectado'}
        </Badge>
      </div>

      {connection?.error && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="O Asaas recusou a chave">
          {connection.error}. O botão de pagar saiu do Portal até a chave ser reconectada. Confira
          no painel do Asaas se ela está ativa e cole-a de novo abaixo.
        </Alert>
      )}

      {connection && (
        <p className="text-sm">
          Conta de {ASAAS_ENVIRONMENT_LABELS[connection.environment].toLowerCase()}, chave terminada
          em <span className="font-mono font-medium">···{connection.last4}</span>, conectada em{' '}
          {new Date(connection.verifiedAt).toLocaleDateString('pt-BR')}.
        </p>
      )}

      <FormError message={error} />

      {canEdit ? (
        <>
          <div>
            <p className="label">Ambiente</p>
            <div className="mt-2">
              <Segmented
                ariaLabel="Ambiente do Asaas"
                disabled={saving || removing}
                value={environment}
                onChange={setEnvironment}
                options={ASAAS_ENVIRONMENTS.map((value) => ({
                  value,
                  label: ASAAS_ENVIRONMENT_LABELS[value],
                }))}
              />
            </div>
          </div>

          <Field
            label={connection ? 'Trocar a chave' : 'Chave da API do Asaas'}
            htmlFor="asaasKey"
            hint="No Asaas: Integrações › Chaves de API. A chave de teste só vale no sandbox."
            error={fieldError}
          >
            <input
              id="asaasKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="field font-mono"
              value={apiKey}
              disabled={saving || removing}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="$aact_…"
            />
          </Field>

          {confirmingRemove ? (
            <Alert tone="danger" icon={<AlertTriangleIcon />} title="Desconectar o Asaas?">
              O botão de pagar sai do Portal e do app, e os links em aberto são cancelados aqui. Se
              um tutor pagar um link antigo mesmo assim, o dinheiro cai na conta do Asaas, mas a
              baixa precisa ser registrada à mão no balcão.
              <span className="mt-3 flex flex-wrap gap-3">
                <Button
                  type="button"
                  busy={removing}
                  onClick={disconnect}
                  busyLabel="Desconectando…"
                >
                  Sim, desconectar
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
                onClick={connect}
                busyLabel="Conectando…"
              >
                {connection ? 'Reconectar' : 'Conectar'}
              </Button>
              {connection && (
                <Button type="button" disabled={saving} onClick={() => setConfirmingRemove(true)}>
                  Desconectar
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          Conectar a conta do Asaas é uma ação do administrador do estabelecimento.
        </p>
      )}
    </Card>
  )
}
