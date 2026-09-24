'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_CHANNEL_PREF_LABELS,
  MessageChannelPrefSchema,
  MessageChannelSchema,
  PLAN_CATALOG,
  SUPPRESSION_REASON_LABELS,
  automationPlanFeature,
  minimumPlanFor,
  planIncludes,
  type AutomationKey,
  type AutomationResponse,
  type MessageChannel,
  type MessageChannelPref,
  type MessagingSettingsResponse,
  type Plan,
  type SuppressionResponse,
  type WhatsappConnection,
} from '@petshop/shared-types'
import { Alert, Badge, Button, Card, Field, FormError, SectionHead } from '@/components/ui'
import { useToast } from '@/components/toast'
import { BellIcon, CalendarIcon, ShieldCheckIcon, SparkleIcon } from '@/components/icons'
import {
  createSuppressionAction,
  deleteSuppressionAction,
  updateAutomationAction,
  updateMessagingSettingsAction,
} from '../config-actions'
import { WhatsappCard } from './whatsapp-card'

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
  whatsapp: WhatsappConnection | null
  canConnectChannel: boolean
  /** O plano do estabelecimento: o WhatsApp e as campanhas automáticas são do Pro. */
  plan: Plan
}

export function CrmSettingsForm({
  settings,
  automations,
  suppressions,
  whatsapp,
  canConnectChannel,
  plan,
}: Props) {
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  // O "salvo" morava no topo da página, fora de vista para quem salvou lá embaixo; o
  // aviso no pé da tela aparece onde quer que a pessoa esteja. `null` é o "limpar"
  // que cada bloco manda antes de gravar — com o aviso sumindo sozinho, não há o que
  // limpar.
  const setSaved = (message: string | null) => {
    if (message) toast(message)
  }

  return (
    <div className="space-y-6">
      <FormError message={error} />

      {/* Antes da chave geral: ela decide **se** manda, o cartão decide **por onde** —
          e um motor ligado sem canal de WhatsApp entrega tudo por e-mail sem avisar. */}
      {planIncludes(plan, 'WHATSAPP') ? (
        whatsapp && <WhatsappCard initial={whatsapp} canConnect={canConnectChannel} />
      ) : (
        <Alert
          tone="accent"
          role="status"
          icon={<SparkleIcon />}
          title={`WhatsApp está no plano ${PLAN_CATALOG[minimumPlanFor('WHATSAPP')].name}`}
        >
          No plano {PLAN_CATALOG[plan].name}, as mensagens automáticas saem por e-mail.
        </Alert>
      )}
      <MasterSwitch settings={settings} onError={setError} onSaved={setSaved} />
      <Automations automations={automations} plan={plan} onError={setError} onSaved={setSaved} />
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
    <Card tone="soft" className={settings.enabled ? '' : 'border-accent/40'}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <SectionHead
            icon={<BellIcon />}
            tone="icon-brand"
            eyebrow="Relacionamento"
            title="Envio automático"
            description={
              settings.enabled
                ? 'As automações ligadas abaixo mandam mensagem sozinhas.'
                : 'Nada sai enquanto isto estiver desligado, nem o que estiver ligado abaixo.'
            }
          />
        </div>
        <Button
          type="button"
          busy={pending}
          onClick={() => toggle(!settings.enabled)}
          busyLabel="Salvando…"
        >
          {settings.enabled ? 'Desligar' : 'Ligar'}
        </Button>
      </div>
    </Card>
  )
}

/** O que o sistema manda sozinho, e a partir de qual evento. */
/** O plano que falta para a automação, ou `null` quando o do estabelecimento a inclui. */
function planoQueFalta(key: string, plan: Plan): string | null {
  const feature = automationPlanFeature(key as AutomationKey)
  if (!feature || planIncludes(plan, feature)) return null
  return PLAN_CATALOG[minimumPlanFor(feature)].name
}

function Automations({
  automations,
  plan,
  onError,
  onSaved,
}: BlockProps & { automations: AutomationResponse[]; plan: Plan }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (automations.length === 0) {
    return (
      <Card tone="soft">
        <SectionHead
          icon={<BellIcon />}
          tone="icon-brand"
          eyebrow="Relacionamento"
          title="Automações"
          description="O serviço de automações não respondeu. As mensagens já enfileiradas continuam saindo; só a configuração está indisponível."
        />
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
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<BellIcon />}
        tone="icon-brand"
        eyebrow="Relacionamento"
        title="Automações"
      />

      <div className="space-y-3">
        {automations.map((automation) => {
          // Descer de plano não desliga a automação: o interruptor mostra o gravado, travado,
          // e o backend é quem cala o envio. Voltar ao plano a religa como estava.
          const falta = planoQueFalta(automation.key, plan)
          return (
            <div key={automation.key} className="rounded-xl border border-line px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {automation.label}
                    {falta && (
                      <span className="ml-2 align-middle">
                        <Badge>Plano {falta}</Badge>
                      </span>
                    )}
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
                    className="check"
                    type="checkbox"
                    checked={automation.enabled}
                    disabled={pending || falta !== null}
                    onChange={(event) =>
                      save(automation.key, { enabled: event.target.checked }, automation.label)
                    }
                  />
                  Ligada
                </label>
              </div>

              {automation.enabled && !falta && (
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
                  {'sendHour' in automation.config && (
                    <Field
                      label="Hora do envio"
                      htmlFor={`hora-${automation.key}`}
                      hint="No fuso do estabelecimento"
                    >
                      <input
                        id={`hora-${automation.key}`}
                        type="number"
                        className="field"
                        min={0}
                        max={23}
                        defaultValue={Number(automation.config.sendHour ?? 9)}
                        disabled={pending}
                        onBlur={(event) => {
                          const value = Number(event.target.value)
                          if (value === Number(automation.config.sendHour)) return
                          save(automation.key, { config: { sendHour: value } }, automation.label)
                        }}
                      />
                    </Field>
                  )}

                  {'inactiveDays' in automation.config && (
                    <Field
                      label="Considerar inativo depois de"
                      htmlFor={`inativo-${automation.key}`}
                      hint="Dias sem atendimento"
                    >
                      <input
                        id={`inativo-${automation.key}`}
                        type="number"
                        className="field"
                        min={30}
                        max={730}
                        defaultValue={Number(automation.config.inactiveDays ?? 90)}
                        disabled={pending}
                        onBlur={(event) => {
                          const value = Number(event.target.value)
                          if (value === Number(automation.config.inactiveDays)) return
                          save(
                            automation.key,
                            { config: { inactiveDays: value } },
                            automation.label,
                          )
                        }}
                      />
                    </Field>
                  )}

                  {'cooldownDays' in automation.config && (
                    <Field
                      label="Não repetir antes de"
                      htmlFor={`carencia-${automation.key}`}
                      hint="Dias entre um convite e o seguinte para a mesma pessoa"
                    >
                      <input
                        id={`carencia-${automation.key}`}
                        type="number"
                        className="field"
                        min={7}
                        max={365}
                        defaultValue={Number(automation.config.cooldownDays ?? 60)}
                        disabled={pending}
                        onBlur={(event) => {
                          const value = Number(event.target.value)
                          if (value === Number(automation.config.cooldownDays)) return
                          save(
                            automation.key,
                            { config: { cooldownDays: value } },
                            automation.label,
                          )
                        }}
                      />
                    </Field>
                  )}

                  {'minDebtCents' in automation.config && (
                    <Field
                      label="Não cobrar abaixo de"
                      htmlFor={`piso-${automation.key}`}
                      hint="Em reais. Cobrar troco custa mais que o troco"
                    >
                      <input
                        id={`piso-${automation.key}`}
                        type="number"
                        className="field"
                        min={0}
                        step={1}
                        defaultValue={Math.round(
                          Number(automation.config.minDebtCents ?? 2000) / 100,
                        )}
                        disabled={pending}
                        onBlur={(event) => {
                          const cents = Math.round(Number(event.target.value) * 100)
                          if (cents === Number(automation.config.minDebtCents)) return
                          save(
                            automation.key,
                            { config: { minDebtCents: cents } },
                            automation.label,
                          )
                        }}
                      />
                    </Field>
                  )}

                  {'includeEstimated' in automation.config && (
                    <label className="flex items-center gap-2 self-end pb-2 text-sm">
                      <input
                        className="check"
                        type="checkbox"
                        defaultChecked={automation.config.includeEstimated === true}
                        disabled={pending}
                        onChange={(event) =>
                          save(
                            automation.key,
                            { config: { includeEstimated: event.target.checked } },
                            automation.label,
                          )
                        }
                      />
                      Incluir data de nascimento estimada
                    </label>
                  )}

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
                          save(automation.key, { config: { leadHours: value } }, automation.label)
                        }}
                      />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )
        })}
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
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<CalendarIcon />}
        tone="icon-brand"
        eyebrow="Relacionamento"
        title="Quando e quanto"
        description={`Horários no fuso do estabelecimento (${settings.timezone}). Mensagem sobre o pet em atendimento — o leva-e-traz — atravessa a janela fechada: ela é sobre agora.`}
      />

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
          label="Máximo de promoções por tutor"
          htmlFor="marketingWeeklyCap"
          hint="Por semana, somando todas as campanhas. Lembrete e leva-e-traz não contam. 0 desliga"
          error={fieldErrors.marketingWeeklyCap}
        >
          <input
            id="marketingWeeklyCap"
            type="number"
            className="field"
            min={0}
            max={20}
            defaultValue={settings.marketingWeeklyCap}
            disabled={pending}
            onBlur={(event) =>
              Number(event.target.value) !== settings.marketingWeeklyCap &&
              save({ marketingWeeklyCap: Number(event.target.value) }, 'Teto por tutor')
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
          className="check"
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
    <Card tone="soft" className="space-y-5">
      <div>
        <SectionHead
          icon={<ShieldCheckIcon />}
          tone="icon-brand"
          eyebrow="Relacionamento"
          title="Bloqueios"
          description="Endereços que o sistema não tenta mais. Entram sozinhos quando o e-mail volta como inexistente, e à mão quando o cliente pede. O endereço não é exibido: fica guardado só como impressão digital."
        />
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

        <Button
          type="button"
          busy={pending}
          disabled={address.trim().length < 3}
          onClick={add}
          busyLabel="Bloqueando…"
        >
          Bloquear
        </Button>
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
                <span className="font-medium">{MESSAGE_CHANNEL_LABELS[suppression.channel]}</span>
                <span className="text-muted">
                  {' '}
                  · {SUPPRESSION_REASON_LABELS[suppression.reason]} ·{' '}
                  {new Date(suppression.createdAt).toLocaleDateString('pt-BR')}
                </span>
              </div>
              <Button
                type="button"
                className="px-3 py-1 text-xs"
                busy={pending}
                onClick={() => remove(suppression.id)}
                busyLabel="Desbloqueando…"
              >
                Desbloquear
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
