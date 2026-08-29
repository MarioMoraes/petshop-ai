'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_CHANNEL_PREF_LABELS,
  MessageChannelPrefSchema,
  MessageChannelSchema,
  SUPPRESSION_REASON_LABELS,
  type AutomationResponse,
  type MessageChannel,
  type MessageChannelPref,
  type MessagingSettingsResponse,
  type SuppressionResponse,
} from '@petshop/shared-types'
import { Badge, Card, Field, FormError } from '@/components/ui'
import {
  createSuppressionAction,
  deleteSuppressionAction,
  updateAutomationAction,
  updateMessagingSettingsAction,
} from '../config-actions'

/**
 * Cada bloco salva sozinho, como em `/configuracoes` e no Taxi Dog.
 *
 * Um "salvar tudo" faria quem só queria mudar a janela de silêncio reenviar também o
 * teto diário e o remetente — e um erro em qualquer campo derrubaria a edição inteira.
 */

interface Props {
  settings: MessagingSettingsResponse
  automations: AutomationResponse[]
  suppressions: SuppressionResponse[]
}

export function CrmSettingsForm({ settings, automations, suppressions }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <FormError message={error} />
      {saved && <p className="text-sm text-success">{saved}</p>}

      <MasterSwitch settings={settings} onError={setError} onSaved={setSaved} />
      <Automations automations={automations} onError={setError} onSaved={setSaved} />
      <EngineSettings settings={settings} onError={setError} onSaved={setSaved} />
      <Suppressions suppressions={suppressions} onError={setError} onSaved={setSaved} />
    </div>
  )
}

interface BlockProps {
  onError: (message: string | null) => void
  onSaved: (message: string | null) => void
}

/**
 * A chave geral.
 *
 * Fica sozinha, no topo e fora do bloco de ajustes, porque é de outra ordem: os
 * demais campos afinam **como** se envia, este decide **se** se envia. Desligado, nada
 * sai — nem o que as automações abaixo dizem estar ligado, e a tela precisa dizer isso
 * em vez de deixar o admin concluir que configurou algo que não vai acontecer.
 */
function MasterSwitch({
  settings,
  onError,
  onSaved,
}: BlockProps & { settings: MessagingSettingsResponse }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function toggle(enabled: boolean) {
    onError(null)
    onSaved(null)
    startTransition(async () => {
      const result = await updateMessagingSettingsAction({ enabled })
      if (!result.ok) {
        onError(result.message)
        return
      }
      onSaved(enabled ? 'Envio automático ligado.' : 'Envio automático desligado.')
      router.refresh()
    })
  }

  return (
    <Card className={settings.enabled ? '' : 'border-accent/40'}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-medium">Envio automático</h2>
          <p className="hint mt-1">
            {settings.enabled
              ? 'As automações ligadas abaixo mandam mensagem sozinhas.'
              : 'Nada sai enquanto isto estiver desligado, nem o que estiver ligado abaixo.'}
          </p>
        </div>
        <button
          type="button"
          className={settings.enabled ? 'btn btn-ghost' : 'btn btn-primary'}
          disabled={pending}
          onClick={() => toggle(!settings.enabled)}
        >
          {settings.enabled ? 'Desligar' : 'Ligar'}
        </button>
      </div>
    </Card>
  )
}

/** O que o sistema manda sozinho, e a partir de qual evento. */
function Automations({
  automations,
  onError,
  onSaved,
}: BlockProps & { automations: AutomationResponse[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (automations.length === 0) {
    return (
      <Card>
        <h2 className="font-medium">Automações</h2>
        <p className="hint mt-1">
          O serviço de automações não respondeu. As mensagens já enfileiradas continuam
          saindo; só a configuração está indisponível.
        </p>
      </Card>
    )
  }

  function save(key: string, input: Record<string, unknown>, label: string) {
    onError(null)
    onSaved(null)
    startTransition(async () => {
      const result = await updateAutomationAction(key, input)
      if (!result.ok) {
        onError(result.message)
        return
      }
      onSaved(`${label} atualizada.`)
      router.refresh()
    })
  }

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Automações</h2>

      <div className="space-y-3">
        {automations.map((automation) => (
          <div key={automation.key} className="rounded-xl border border-line px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {automation.label}
                  {!automation.isDefault && (
                    <span className="ml-2 align-middle">
                      <Badge tone="accent">Ajustada</Badge>
                    </span>
                  )}
                </p>
                <p className="hint mt-0.5">{automation.description}</p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={automation.enabled}
                  disabled={pending}
                  onChange={(event) =>
                    save(automation.key, { enabled: event.target.checked }, automation.label)
                  }
                />
                Ligada
              </label>
            </div>

            {automation.enabled && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Canal" htmlFor={`canal-${automation.key}`}>
                  <select
                    id={`canal-${automation.key}`}
                    className="field"
                    value={automation.channel}
                    disabled={pending}
                    onChange={(event) =>
                      save(
                        automation.key,
                        { channel: event.target.value as MessageChannelPref },
                        automation.label,
                      )
                    }
                  >
                    {MessageChannelPrefSchema.options.map((option) => (
                      <option key={option} value={option}>
                        {MESSAGE_CHANNEL_PREF_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </Field>

                {/*
                 * Só o lembrete tem antecedência — a `config` é validada por união
                 * discriminada no serviço, e mandar `leadHours` numa automação que não
                 * o conhece é 422. Renderizar o campo para todas seria oferecer um
                 * ajuste que o servidor recusa.
                 */}
                {'leadHours' in automation.config && (
                  <Field
                    label="Antecedência"
                    htmlFor={`lead-${automation.key}`}
                    hint="Horas antes do horário marcado"
                  >
                    <input
                      id={`lead-${automation.key}`}
                      type="number"
                      className="field"
                      min={1}
                      max={168}
                      defaultValue={Number(automation.config.leadHours ?? 24)}
                      disabled={pending}
                      onBlur={(event) => {
                        const value = Number(event.target.value)
                        if (value === Number(automation.config.leadHours)) return
                        save(
                          automation.key,
                          { config: { leadHours: value } },
                          automation.label,
                        )
                      }}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Quando e quanto o motor pode mandar. */
function EngineSettings({
  settings,
  onError,
  onSaved,
}: BlockProps & { settings: MessagingSettingsResponse }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function save(input: Record<string, unknown>, label: string) {
    onError(null)
    onSaved(null)
    setFieldErrors({})
    startTransition(async () => {
      const result = await updateMessagingSettingsAction(input)
      if (!result.ok) {
        onError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      onSaved(`${label} salvo.`)
      router.refresh()
    })
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-medium">Quando e quanto</h2>
        <p className="hint mt-1">
          Horários no fuso do estabelecimento ({settings.timezone}). Mensagem sobre o pet
          em atendimento — o leva-e-traz — atravessa a janela fechada: ela é sobre agora.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Não enviar antes de" htmlFor="quietStart" error={fieldErrors.quietStart}>
          <input
            id="quietStart"
            type="time"
            className="field"
            defaultValue={settings.quietStart}
            disabled={pending}
            onBlur={(event) =>
              event.target.value !== settings.quietStart &&
              save({ quietStart: event.target.value }, 'Janela')
            }
          />
        </Field>

        <Field label="Nem depois de" htmlFor="quietEnd" error={fieldErrors.quietEnd}>
          <input
            id="quietEnd"
            type="time"
            className="field"
            defaultValue={settings.quietEnd}
            disabled={pending}
            onBlur={(event) =>
              event.target.value !== settings.quietEnd &&
              save({ quietEnd: event.target.value }, 'Janela')
            }
          />
        </Field>

        <Field
          label="Máximo por dia"
          htmlFor="dailyCap"
          hint="Teto de segurança: um erro de automação para aqui"
          error={fieldErrors.dailyCap}
        >
          <input
            id="dailyCap"
            type="number"
            className="field"
            min={0}
            max={10000}
            defaultValue={settings.dailyCap}
            disabled={pending}
            onBlur={(event) =>
              Number(event.target.value) !== settings.dailyCap &&
              save({ dailyCap: Number(event.target.value) }, 'Teto diário')
            }
          />
        </Field>

        <Field
          label="Máximo por minuto"
          htmlFor="perMinuteCap"
          hint="Ritmo do disparo"
          error={fieldErrors.perMinuteCap}
        >
          <input
            id="perMinuteCap"
            type="number"
            className="field"
            min={1}
            max={60}
            defaultValue={settings.perMinuteCap}
            disabled={pending}
            onBlur={(event) =>
              Number(event.target.value) !== settings.perMinuteCap &&
              save({ perMinuteCap: Number(event.target.value) }, 'Ritmo')
            }
          />
        </Field>

        <Field label="Canal preferido" htmlFor="defaultChannel">
          <select
            id="defaultChannel"
            className="field"
            value={settings.defaultChannel}
            disabled={pending}
            onChange={(event) =>
              save({ defaultChannel: event.target.value as MessageChannelPref }, 'Canal')
            }
          >
            {MessageChannelPrefSchema.options.map((option) => (
              <option key={option} value={option}>
                {MESSAGE_CHANNEL_PREF_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Guardar o histórico por"
          htmlFor="retentionMonths"
          hint="Meses. Depois disso o texto é apagado e a linha continua, para estatística"
          error={fieldErrors.retentionMonths}
        >
          <input
            id="retentionMonths"
            type="number"
            className="field"
            min={6}
            max={60}
            defaultValue={settings.retentionMonths}
            disabled={pending}
            onBlur={(event) =>
              Number(event.target.value) !== settings.retentionMonths &&
              save({ retentionMonths: Number(event.target.value) }, 'Retenção')
            }
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.marketingWeekdaysOnly}
          disabled={pending}
          onChange={(event) =>
            save({ marketingWeekdaysOnly: event.target.checked }, 'Dias de marketing')
          }
        />
        Marketing só em dia útil
      </label>

      <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <Field
          label="Nome do remetente"
          htmlFor="senderName"
          hint="Como o e-mail se apresenta"
          error={fieldErrors.senderName}
        >
          <input
            id="senderName"
            className="field"
            maxLength={60}
            defaultValue={settings.senderName ?? ''}
            disabled={pending}
            onBlur={(event) =>
              event.target.value !== (settings.senderName ?? '') &&
              save({ senderName: event.target.value || null }, 'Remetente')
            }
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
            defaultValue={settings.replyToEmail ?? ''}
            disabled={pending}
            onBlur={(event) =>
              event.target.value !== (settings.replyToEmail ?? '') &&
              save({ replyToEmail: event.target.value || null }, 'Resposta')
            }
          />
        </Field>
      </div>
    </Card>
  )
}

/**
 * Quem não recebe mais, e por quê.
 *
 * A lista **não mostra o endereço**, e não é esquecimento: o banco guarda só o hash
 * (AC-05 de MOD-CRM-04). Uma lista de quem pediu para parar que pudesse ser lida seria,
 * ela mesma, uma lista de contatos exportável — exatamente o que o titular quis evitar.
 * Por isso a tela mostra canal, motivo e data, e quem quer bloquear um endereço o digita.
 */
function Suppressions({
  suppressions,
  onError,
  onSaved,
}: BlockProps & { suppressions: SuppressionResponse[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [address, setAddress] = useState('')
  const [channel, setChannel] = useState<MessageChannel>('EMAIL')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function add() {
    onError(null)
    onSaved(null)
    setFieldErrors({})
    startTransition(async () => {
      const result = await createSuppressionAction({ channel, address, reason: 'MANUAL' })
      if (!result.ok) {
        onError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      setAddress('')
      onSaved('Endereço bloqueado.')
      router.refresh()
    })
  }

  function remove(id: string) {
    onError(null)
    onSaved(null)
    startTransition(async () => {
      const result = await deleteSuppressionAction(id)
      if (!result.ok) {
        onError(result.message)
        return
      }
      onSaved('Bloqueio removido.')
      router.refresh()
    })
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-medium">Bloqueios</h2>
        <p className="hint mt-1">
          Endereços que o sistema não tenta mais. Entram sozinhos quando o e-mail volta
          como inexistente, e à mão quando o cliente pede. O endereço não é exibido: fica
          guardado só como impressão digital.
        </p>
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-[10rem_1fr_auto]">
        <Field label="Canal" htmlFor="sup-channel">
          <select
            id="sup-channel"
            className="field"
            value={channel}
            disabled={pending}
            onChange={(event) => setChannel(event.target.value as MessageChannel)}
          >
            {MessageChannelSchema.options.map((option) => (
              <option key={option} value={option}>
                {MESSAGE_CHANNEL_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={channel === 'EMAIL' ? 'E-mail' : 'Telefone'}
          htmlFor="sup-address"
          error={fieldErrors.address}
        >
          <input
            id="sup-address"
            className="field"
            placeholder={channel === 'EMAIL' ? 'nome@exemplo.com' : '+5511987654321'}
            value={address}
            disabled={pending}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>

        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || address.trim().length < 3}
          onClick={add}
        >
          Bloquear
        </button>
      </div>

      {suppressions.length === 0 ? (
        <p className="hint border-t border-line pt-4">Nenhum endereço bloqueado.</p>
      ) : (
        <ul className="border-t border-line">
          {suppressions.map((suppression) => (
            <li
              key={suppression.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-b-0"
            >
              <div className="min-w-0 text-sm">
                <span className="font-medium">
                  {MESSAGE_CHANNEL_LABELS[suppression.channel]}
                </span>
                <span className="text-muted">
                  {' '}
                  · {SUPPRESSION_REASON_LABELS[suppression.reason]} ·{' '}
                  {new Date(suppression.createdAt).toLocaleDateString('pt-BR')}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost px-3 py-1 text-xs"
                disabled={pending}
                onClick={() => remove(suppression.id)}
              >
                Desbloquear
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
