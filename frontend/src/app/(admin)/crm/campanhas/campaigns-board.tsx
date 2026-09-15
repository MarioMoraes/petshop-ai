'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CAMPAIGN_SKIP_REASON_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_TEMPLATE_KEYS,
  CAMPAIGN_TYPE_LABELS,
  MESSAGE_CHANNEL_PREF_LABELS,
  MessageChannelPrefSchema,
  templateLabelOf,
  type CampaignPreview,
  type CampaignSkipReason,
  type CampaignSummary,
  type CampaignTargetRow,
  type MessageChannelPref,
} from '@petshop/shared-types'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormError,
  SectionHead,
} from '@/components/ui'
import { Modal } from '@/components/modal'
import { AlertTriangleIcon, BellIcon } from '@/components/icons'
import {
  cancelCampaignAction,
  createCampaignAction,
  listCampaignTargetsAction,
  previewCampaignAction,
  runCampaignAction,
} from '../campaign-actions'

/**
 * A lista de campanhas e o caminho até o disparo.
 *
 * O caminho é de três passos, e a ordem é a defesa da tela: **monta**, **vê quem
 * recebe**, **dispara com o número que viu**. Não existe atalho do primeiro para o
 * terceiro — o botão de disparar só nasce depois da prévia, e leva consigo a contagem
 * que ela devolveu. Se o segmento mudar nesse intervalo, o servidor recusa com 409 e a
 * tela pede uma prévia nova em vez de mandar para uma lista que ninguém aprovou.
 */

interface Props {
  campaigns: CampaignSummary[]
  canSend: boolean
}

export function CampaignsBoard({ campaigns, canSend }: Props) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-5">
      <FormError message={error} />

      {canSend && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setCreating(true)}>
            Nova campanha
          </Button>
        </div>
      )}

      {campaigns.length === 0 ? (
        <EmptyState
          title="Nenhuma campanha ainda"
          description={
            canSend
              ? 'Uma campanha é um envio para muita gente de uma vez. Monte o filtro, veja quem recebe e só então dispare.'
              : 'Quem tem permissão de envio monta as campanhas do estabelecimento.'
          }
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              canSend={canSend}
              onError={setError}
            />
          ))}
        </div>
      )}

      {creating && <CreateCampaignModal onClose={() => setCreating(false)} />}
    </div>
  )
}

/** Uma campanha na lista, com os números da última execução. */
function CampaignRow({
  campaign,
  canSend,
  onError,
}: {
  campaign: CampaignSummary
  canSend: boolean
  onError: (message: string | null) => void
}) {
  const [dispatching, setDispatching] = useState(false)
  const [targets, setTargets] = useState<CampaignTargetRow[] | null>(null)

  const isSystem = campaign.type === 'INACTIVE'
  const canRun =
    canSend && !isSystem && (campaign.status === 'DRAFT' || campaign.status === 'SCHEDULED')

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {campaign.name}
            <span className="ml-2 align-middle">
              <Badge tone={campaign.status === 'DONE' ? 'accent' : 'neutral'}>
                {CAMPAIGN_STATUS_LABELS[campaign.status]}
              </Badge>
            </span>
          </p>
          <p className="hint mt-0.5">
            {CAMPAIGN_TYPE_LABELS[campaign.type]} · {campaign.templateLabel} ·{' '}
            {MESSAGE_CHANNEL_PREF_LABELS[campaign.channel]}
          </p>
          <p className="hint mt-0.5">{describeSegment(campaign)}</p>
        </div>

        <div className="flex shrink-0 gap-2">
          {campaign.lastRun && (
            <Button
              type="button"
              onClick={async () => {
                onError(null)
                const result = await listCampaignTargetsAction(campaign.lastRun!.id)
                if (!result.ok) {
                  onError(result.message)
                  return
                }
                setTargets(result.data)
              }}
            >
              Ver resultado
            </Button>
          )}
          {canRun && (
            <Button type="button" onClick={() => setDispatching(true)}>
              Ver quem recebe
            </Button>
          )}
        </div>
      </div>

      {campaign.lastRun && (
        <p className="hint">
          Última execução: {campaign.lastRun.sent} enviadas, {campaign.lastRun.skipped} puladas
          {campaign.lastRun.failed > 0 && `, ${campaign.lastRun.failed} com falha`}.
        </p>
      )}

      {isSystem && (
        <p className="hint">
          Esta campanha é do sistema: ela roda sozinha enquanto o convite de volta estiver ligado em
          Configuração.
        </p>
      )}

      {dispatching && <DispatchModal campaign={campaign} onClose={() => setDispatching(false)} />}
      {targets && (
        <TargetsModal campaign={campaign} targets={targets} onClose={() => setTargets(null)} />
      )}
    </Card>
  )
}

/**
 * A prévia e o disparo, na mesma janela.
 *
 * Ficam juntos porque são um só ato do usuário: separá-los em duas telas deixaria a
 * pessoa disparar com um número lido de memória, que é justamente o que a confirmação
 * de contagem existe para impedir.
 */
function DispatchModal({ campaign, onClose }: { campaign: CampaignSummary; onClose: () => void }) {
  const router = useRouter()
  const [preview, setPreview] = useState<CampaignPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ sent: number; skipped: number } | null>(null)
  const [pending, startTransition] = useTransition()

  function loadPreview() {
    setError(null)
    startTransition(async () => {
      const result = await previewCampaignAction(campaign.id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setPreview(result.data)
    })
  }

  function dispatch() {
    if (!preview) return
    setError(null)
    startTransition(async () => {
      const result = await runCampaignAction(campaign.id, preview.eligible)
      if (!result.ok) {
        setError(result.message)
        // A contagem mudou entre a prévia e o clique: a prévia velha some, para não
        // haver um número na tela que ninguém mais pode confirmar.
        if (result.actualTargets !== undefined) setPreview(null)
        return
      }
      setDone({ sent: result.data.sent, skipped: result.data.skipped })
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={pending}
      icon={<BellIcon />}
      tone="icon-brand"
      eyebrow="Campanha"
      title={campaign.name}
      subtitle={`${campaign.templateLabel} · ${MESSAGE_CHANNEL_PREF_LABELS[campaign.channel]}`}
      footer={
        done ? (
          <Button type="button" onClick={onClose}>
            Fechar
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancelar
            </Button>
            {preview ? (
              <Button
                type="button"
                busy={pending}
                disabled={preview.eligible === 0}
                onClick={dispatch}
                busyLabel="Enviando…"
              >
                Enviar para {preview.eligible}
              </Button>
            ) : (
              <Button type="button" busy={pending} onClick={loadPreview} busyLabel="Carregando…">
                Ver quem recebe
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-4">
        <FormError message={error} />

        {done ? (
          <Alert tone="accent" icon={<BellIcon />} title="Campanha disparada" role="status">
            {done.sent} {done.sent === 1 ? 'mensagem entrou' : 'mensagens entraram'} na fila.{' '}
            {done.skipped > 0 && `${done.skipped} pessoas ficaram de fora.`} O envio segue o ritmo e
            a janela configurados.
          </Alert>
        ) : preview ? (
          <PreviewPanel preview={preview} />
        ) : (
          <p className="hint">
            A lista é montada agora, no clique — e não quando a campanha foi criada. Quem voltou
            ontem sai do filtro sozinho.
          </p>
        )}
      </div>
    </Modal>
  )
}

function PreviewPanel({ preview }: { preview: CampaignPreview }) {
  const reasons = Object.entries(preview.skippedByReason) as [CampaignSkipReason, number][]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Na mira" value={preview.targeted} />
        <Stat label="Recebem" value={preview.eligible} />
        <Stat label="Ficam de fora" value={preview.skipped} />
      </div>

      {preview.eligible === 0 && (
        <Alert tone="accent" icon={<AlertTriangleIcon />} title="Ninguém receberia" role="status">
          Todo mundo na mira está barrado por algum dos motivos abaixo.
        </Alert>
      )}

      {reasons.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Por que ficam de fora</p>
          {reasons
            .sort(([, left], [, right]) => right - left)
            .map(([reason, count]) => (
              <div key={reason} className="flex justify-between text-sm">
                <span className="text-muted">{CAMPAIGN_SKIP_REASON_LABELS[reason]}</span>
                <span>{count}</span>
              </div>
            ))}
        </div>
      )}

      {preview.sample.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Alguns dos que recebem</p>
          <p className="hint">{preview.sample.map((row) => row.name).join(', ')}</p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2">
      <p className="hint">{label}</p>
      <p className="text-lg font-medium">{value}</p>
    </div>
  )
}

/** Quem recebeu, quem ficou de fora e por quê — a prestação de contas da execução. */
function TargetsModal({
  campaign,
  targets,
  onClose,
}: {
  campaign: CampaignSummary
  targets: CampaignTargetRow[]
  onClose: () => void
}) {
  const [cancelling, startTransition] = useTransition()
  const router = useRouter()

  const sent = targets.filter((target) => target.status === 'SENT')
  const skipped = targets.filter((target) => target.status !== 'SENT')

  return (
    <Modal
      open
      onClose={onClose}
      busy={cancelling}
      icon={<BellIcon />}
      tone="icon-brand"
      eyebrow="Resultado"
      title={campaign.name}
      subtitle={`${sent.length} receberam · ${skipped.length} ficaram de fora`}
      footer={
        <Button type="button" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-4">
        {skipped.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Ficaram de fora</p>
            {skipped.map((target) => (
              <div key={target.id} className="flex justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{target.tutorName}</span>
                <span className="hint shrink-0">
                  {target.skipReason ? CAMPAIGN_SKIP_REASON_LABELS[target.skipReason] : '—'}
                </span>
              </div>
            ))}
          </div>
        )}

        {sent.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Receberam</p>
            <p className="hint">{sent.map((target) => target.tutorName).join(', ')}</p>
          </div>
        )}

        {/* Ação destrutiva no pé do corpo, nunca no rodapé: ela fica a um deslize do
            polegar da ação principal (docs/design-formularios.md, §8). */}
        {campaign.status !== 'CANCELLED' && campaign.type !== 'INACTIVE' && (
          <button
            type="button"
            className="text-sm text-muted underline"
            disabled={cancelling}
            onClick={() =>
              startTransition(async () => {
                await cancelCampaignAction(campaign.id)
                router.refresh()
                onClose()
              })
            }
          >
            Cancelar o que ainda não saiu
          </button>
        )}
      </div>
    </Modal>
  )
}

/** Montar a campanha: o texto, o canal e para quem. */
function CreateCampaignModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [name, setName] = useState('')
  const [templateKey, setTemplateKey] = useState<string>(CAMPAIGN_TEMPLATE_KEYS[0])
  const [channel, setChannel] = useState<MessageChannelPref>('AUTO')
  const [inactiveDays, setInactiveDays] = useState('')
  const [excludeDebtors, setExcludeDebtors] = useState(true)
  const [requiresActivePet, setRequiresActivePet] = useState(true)

  function submit() {
    setError(null)
    setFieldErrors({})
    startTransition(async () => {
      const days = Number.parseInt(inactiveDays, 10)
      const result = await createCampaignAction({
        name,
        templateKey,
        channel,
        segment: {
          ...(Number.isFinite(days) && days > 0 ? { inactiveDaysMin: days } : {}),
          excludeDebtors,
          requiresActivePet,
        },
        scheduledFor: null,
      })
      if (!result.ok) {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={pending}
      icon={<BellIcon />}
      tone="icon-brand"
      eyebrow="Campanha"
      title="Nova campanha"
      subtitle="Ela nasce como rascunho. Nada sai antes da prévia."
      footer={
        <>
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            busy={pending}
            disabled={name.trim().length === 0}
            onClick={submit}
            busyLabel="Criando…"
          >
            Criar rascunho
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={error} />

        <div className="space-y-4">
          <SectionHead
            icon={<BellIcon />}
            tone="icon-brand"
            eyebrow="Relacionamento"
            title="O que vai sair"
          />

          <Field label="Nome da campanha" htmlFor="name" error={fieldErrors.name}>
            <input
              id="name"
              className="field"
              value={name}
              maxLength={120}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field
            label="Texto"
            htmlFor="templateKey"
            hint="Só textos de promoção. Edite o conteúdo em Textos."
            error={fieldErrors.templateKey}
          >
            <select
              id="templateKey"
              className="field"
              value={templateKey}
              disabled={pending}
              onChange={(event) => setTemplateKey(event.target.value)}
            >
              {CAMPAIGN_TEMPLATE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {templateLabelOf(key)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Canal" htmlFor="channel">
            <select
              id="channel"
              className="field"
              value={channel}
              disabled={pending}
              onChange={(event) => setChannel(event.target.value as MessageChannelPref)}
            >
              {MessageChannelPrefSchema.options.map((option) => (
                <option key={option} value={option}>
                  {MESSAGE_CHANNEL_PREF_LABELS[option]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="space-y-4">
          <SectionHead
            icon={<BellIcon />}
            tone="icon-brand"
            eyebrow="Relacionamento"
            title="Para quem"
            description="Sem nenhum filtro, a campanha alcança todo tutor ativo do estabelecimento."
          />

          <Field
            label="Sem atendimento há pelo menos"
            htmlFor="inactiveDays"
            hint="Dias. Deixe em branco para não filtrar por isso."
            error={fieldErrors['segment.inactiveDaysMin']}
          >
            <input
              id="inactiveDays"
              type="number"
              className="field"
              min={1}
              max={3650}
              value={inactiveDays}
              disabled={pending}
              onChange={(event) => setInactiveDays(event.target.value)}
            />
          </Field>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                className="check"
                type="checkbox"
                checked={excludeDebtors}
                disabled={pending}
                onChange={(event) => setExcludeDebtors(event.target.checked)}
              />
              Não incluir quem tem valor em aberto
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                className="check"
                type="checkbox"
                checked={requiresActivePet}
                disabled={pending}
                onChange={(event) => setRequiresActivePet(event.target.checked)}
              />
              Só quem tem pet ativo
            </label>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** O filtro em uma frase, para a linha da lista. */
function describeSegment(campaign: CampaignSummary): string {
  const parts: string[] = []
  const segment = campaign.segment

  if (segment.inactiveDaysMin !== undefined) {
    parts.push(`sem atendimento há ${segment.inactiveDaysMin} dias`)
  }
  if (segment.activeDaysMax !== undefined) {
    parts.push(`com atendimento nos últimos ${segment.activeDaysMax} dias`)
  }
  if (segment.tagKeys?.length) parts.push(`com as marcas ${segment.tagKeys.join(', ')}`)
  if (segment.excludeDebtors) parts.push('sem valor em aberto')
  if (segment.requiresActivePet) parts.push('com pet ativo')

  return parts.length > 0 ? `Tutores ${parts.join(', ')}.` : 'Todo tutor ativo do estabelecimento.'
}
