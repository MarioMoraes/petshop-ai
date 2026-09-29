'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CAMPAIGN_BODY_MAX,
  CAMPAIGN_SKIP_REASON_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_TYPE_LABELS,
  MESSAGE_CHANNEL_PREF_LABELS,
  MessageChannelPrefSchema,
  findTemplateDefinition,
  type CampaignPreview,
  type CampaignSkipReason,
  type CampaignSummary,
  type CampaignTargetRow,
  type MessageChannelPref,
  type TemplatePreview,
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
  updateCampaignAction,
} from '../campaign-actions'
import { previewTemplateAction } from '../config-actions'

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
          icon={<BellIcon />}
          tone="icon-brand"
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

      {creating && <CampaignFormModal onClose={() => setCreating(false)} />}
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
  const [editing, setEditing] = useState(false)
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
            <Button type="button" onClick={() => setEditing(true)}>
              Editar
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
      {editing && <CampaignFormModal campaign={campaign} onClose={() => setEditing(false)} />}
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
          <>
            <CampaignText campaign={campaign} />
            <p className="hint">
              A lista é montada agora, no clique — e não quando a campanha foi criada. Quem voltou
              ontem sai do filtro sozinho.
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * O texto que vai sair, à vista antes do disparo.
 *
 * Sem ele a janela de confirmação pedia um "sim" sobre uma lista de pessoas sem mostrar o
 * que elas vão ler — e o texto é justamente o que a pessoa mais quer conferir.
 */
function CampaignText({ campaign }: { campaign: CampaignSummary }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-3">
      <p className="hint">O que vai sair</p>
      {campaign.body ? (
        <>
          {campaign.subject && campaign.channel !== 'WHATSAPP' && (
            <p className="mt-2 text-sm font-medium">{campaign.subject}</p>
          )}
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{campaign.body}</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">
          O texto “{campaign.templateLabel}” de Mensagens › Textos, o mesmo para todas as campanhas
          que o usam. Edite a campanha para escrever um texto só dela.
        </p>
      )}
    </div>
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
            Cancelar o Que Ainda Não Saiu
          </button>
        )}
      </div>
    </Modal>
  )
}

/** O texto de onde a campanha nova parte: o do catálogo, que é um recado genérico. */
const BROADCAST = findTemplateDefinition('campaign_broadcast')!

/**
 * Montar ou editar a campanha: o texto, o canal e para quem.
 *
 * O texto é **da campanha**, e não mais uma escolha entre os textos do catálogo: duas
 * campanhas seguidas precisam dizer coisas diferentes sem que a segunda reescreva a
 * primeira. Nasce preenchido com o recado genérico, para ninguém começar da folha em
 * branco nem esquecer onde entram as marcações.
 */
function CampaignFormModal({
  campaign,
  onClose,
}: {
  campaign?: CampaignSummary
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [sample, setSample] = useState<TemplatePreview | null>(null)

  const templateKey = campaign?.templateKey ?? BROADCAST.key
  const definition = findTemplateDefinition(templateKey) ?? BROADCAST
  // A campanha de antes deste campo não tem texto próprio: o formulário mostra o do
  // catálogo, e só o grava se a pessoa mexer nele (ver `submit`).
  const initialBody = campaign?.body ?? definition.body.WHATSAPP
  const initialSubject = campaign?.subject ?? definition.subject ?? ''

  const [name, setName] = useState(campaign?.name ?? '')
  const [body, setBody] = useState(initialBody)
  const [subject, setSubject] = useState(initialSubject)
  const [channel, setChannel] = useState<MessageChannelPref>(campaign?.channel ?? 'AUTO')
  const [inactiveDays, setInactiveDays] = useState(
    campaign?.segment.inactiveDaysMin !== undefined ? String(campaign.segment.inactiveDaysMin) : '',
  )
  const [excludeDebtors, setExcludeDebtors] = useState(campaign?.segment.excludeDebtors ?? true)
  const [requiresActivePet, setRequiresActivePet] = useState(
    campaign?.segment.requiresActivePet ?? true,
  )

  // O assunto só existe no e-mail; no automático, o e-mail é a queda de quem não tem
  // WhatsApp, e o assunto precisa estar lá quando ela acontecer.
  const showsSubject = channel !== 'WHATSAPP'

  function submit() {
    setError(null)
    setFieldErrors({})
    startTransition(async () => {
      const days = Number.parseInt(inactiveDays, 10)
      const segment = {
        ...campaign?.segment,
        inactiveDaysMin: Number.isFinite(days) && days > 0 ? days : undefined,
        excludeDebtors,
        requiresActivePet,
      }
      const touchedText =
        campaign?.body != null || body !== initialBody || subject !== initialSubject
      const text = touchedText ? { body: body.trim(), subject: subject.trim() || null } : {}

      const result = campaign
        ? await updateCampaignAction(campaign.id, { name, channel, segment, ...text })
        : await createCampaignAction({
            name,
            templateKey,
            channel,
            segment,
            body: body.trim(),
            subject: subject.trim() || null,
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

  function showSample() {
    setError(null)
    startTransition(async () => {
      const result = await previewTemplateAction({
        templateKey,
        channel: channel === 'EMAIL' ? 'EMAIL' : 'WHATSAPP',
        ...(channel === 'EMAIL' && subject.trim() ? { subject: subject.trim() } : {}),
        body,
      })
      if (!result.ok) {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      setSample(result.data)
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
      title={campaign ? campaign.name : 'Nova campanha'}
      subtitle={
        campaign
          ? 'Rascunho: o texto e o filtro ainda podem mudar.'
          : 'Ela nasce como rascunho. Nada sai antes da prévia.'
      }
      footer={
        <>
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            busy={pending}
            disabled={name.trim().length === 0 || body.trim().length === 0}
            onClick={submit}
            busyLabel={campaign ? 'Salvando…' : 'Criando…'}
          >
            {campaign ? 'Salvar' : 'Criar rascunho'}
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

          <Field label="Canal" htmlFor="channel">
            <select
              id="channel"
              className="field"
              value={channel}
              disabled={pending}
              onChange={(event) => {
                setChannel(event.target.value as MessageChannelPref)
                setSample(null)
              }}
            >
              {MessageChannelPrefSchema.options.map((option) => (
                <option key={option} value={option}>
                  {MESSAGE_CHANNEL_PREF_LABELS[option]}
                </option>
              ))}
            </select>
          </Field>

          {showsSubject && (
            <Field
              label="Assunto do e-mail"
              htmlFor="subject"
              error={fieldErrors.subject}
              hint="Só aparece em quem recebe por e-mail."
            >
              <input
                id="subject"
                className="field"
                value={subject}
                maxLength={160}
                disabled={pending}
                onChange={(event) => {
                  setSubject(event.target.value)
                  setSample(null)
                }}
              />
            </Field>
          )}

          <Field
            label="Texto"
            htmlFor="body"
            error={fieldErrors.body}
            hint={`${body.length} de ${CAMPAIGN_BODY_MAX} caracteres. As marcações abaixo viram o dado de cada cliente.`}
          >
            <textarea
              id="body"
              className="field min-h-40"
              value={body}
              maxLength={CAMPAIGN_BODY_MAX}
              disabled={pending}
              onChange={(event) => {
                setBody(event.target.value)
                setSample(null)
              }}
            />
          </Field>

          <div className="flex flex-wrap gap-1.5">
            {definition.variables.map((variable) => (
              <code key={variable} className="pill bg-black/5 px-2.5 py-1 text-xs text-muted">
                {`{{${variable}}}`}
              </code>
            ))}
          </div>

          {sample ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-3">
              <p className="hint">Com dados de exemplo</p>
              {channel === 'EMAIL' && sample.subject && (
                <p className="mt-2 text-sm font-medium">{sample.subject}</p>
              )}
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{sample.body}</p>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                busy={pending}
                disabled={body.trim().length === 0}
                onClick={showSample}
                busyLabel="Gerando…"
              >
                Ver como fica
              </Button>
            </div>
          )}
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
