'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  MESSAGE_BODY_LIMITS,
  MESSAGE_CATEGORY_LABELS,
  MESSAGE_CHANNEL_LABELS,
  templateLabelOf,
  type ResolvedTemplate,
  type TemplatePreview,
} from '@petshop/shared-types'
import { Badge, Button, Card, Field, FormError } from '@/components/ui'
import { previewTemplateAction, resetTemplateAction, saveTemplateAction } from '../config-actions'

/**
 * Os oito textos, agrupados pelo que dizem e não pelo canal em que saem.
 *
 * O agrupamento é por chave — "Lembrete de agendamento" com WhatsApp e e-mail lado a
 * lado — porque a pergunta do admin é sobre a situação ("o que a gente manda quando o
 * horário é marcado?"), não sobre o meio. Listar oito linhas soltas obrigaria a ler o
 * canal para saber do que se trata.
 *
 * Um editor aberto por vez, em painel na própria página: não há diálogo em lugar
 * nenhum deste produto, e comparar o texto novo com o da outra ponta é justamente o
 * que se quer fazer enquanto se escreve.
 */

interface Props {
  templates: ResolvedTemplate[]
  canConfigure: boolean
}

export function TemplatesEditor({ templates, canConfigure }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)

  const groups = groupByKey(templates)

  return (
    <div className="space-y-4">
      {groups.map(([key, variants]) => (
        <Card key={key} className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">{templateLabelOf(key)}</h2>
            <Badge>{MESSAGE_CATEGORY_LABELS[variants[0]!.category]}</Badge>
          </div>

          <div className="space-y-3">
            {variants.map((template) => {
              const id = `${template.key}:${template.channel}`
              return (
                <TemplateRow
                  key={id}
                  template={template}
                  canConfigure={canConfigure}
                  open={openId === id}
                  onToggle={() => setOpenId(openId === id ? null : id)}
                />
              )
            })}
          </div>
        </Card>
      ))}
    </div>
  )
}

function TemplateRow({
  template,
  canConfigure,
  open,
  onToggle,
}: {
  template: ResolvedTemplate
  canConfigure: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-xl border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-left"
      >
        <span className="text-sm font-medium">
          {MESSAGE_CHANNEL_LABELS[template.channel]}
          {!template.active && <span className="text-muted"> · desligado</span>}
        </span>
        {/*
         * O selo diz se o petshop já mexeu neste texto. É o que responde "por que a
         * mensagem mudou?" sem abrir a trilha de auditoria — e é o que decide se o
         * botão de voltar ao padrão faz sentido.
         */}
        {template.isDefault ? (
          <Badge>Texto padrão</Badge>
        ) : (
          <Badge tone="accent">Personalizado · v{template.version}</Badge>
        )}
      </button>

      {open && (
        <div className="border-t border-line px-4 py-4">
          {canConfigure ? (
            <TemplateForm template={template} />
          ) : (
            <ReadOnlyTemplate template={template} />
          )}
        </div>
      )}
    </div>
  )
}

function ReadOnlyTemplate({ template }: { template: ResolvedTemplate }) {
  return (
    <div className="space-y-3">
      {template.subject && <p className="text-sm font-medium">{template.subject}</p>}
      <p className="whitespace-pre-wrap text-sm text-muted">{template.body}</p>
    </div>
  )
}

function TemplateForm({ template }: { template: ResolvedTemplate }) {
  const router = useRouter()
  const [subject, setSubject] = useState(template.subject ?? '')
  const [body, setBody] = useState(template.body)
  const [active, setActive] = useState(template.active)
  const [preview, setPreview] = useState<TemplatePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const limit = MESSAGE_BODY_LIMITS[template.channel]
  const isEmail = template.channel === 'EMAIL'
  const dirty =
    body !== template.body || subject !== (template.subject ?? '') || active !== template.active

  function save() {
    setError(null)
    setFieldErrors({})
    setSaved(false)
    startTransition(async () => {
      const result = await saveTemplateAction(template.key, template.channel, {
        ...(isEmail && subject ? { subject } : {}),
        body,
        active,
      })
      if (!result.ok) {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  function reset() {
    setError(null)
    startTransition(async () => {
      const result = await resetTemplateAction(template.key, template.channel)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setSubject(result.data.subject ?? '')
      setBody(result.data.body)
      setActive(result.data.active)
      setPreview(null)
      router.refresh()
    })
  }

  function runPreview() {
    setError(null)
    startTransition(async () => {
      const result = await previewTemplateAction({
        templateKey: template.key,
        channel: template.channel,
        ...(isEmail && subject ? { subject } : {}),
        body,
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setPreview(result.data)
    })
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />

      {isEmail && (
        <Field label="Assunto" htmlFor={`subject-${template.key}`} error={fieldErrors.subject}>
          <input
            id={`subject-${template.key}`}
            className="field"
            value={subject}
            maxLength={160}
            disabled={pending}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
      )}

      <Field
        label="Texto"
        htmlFor={`body-${template.key}-${template.channel}`}
        error={fieldErrors.body}
        hint={`${body.length} de ${limit} caracteres`}
      >
        <textarea
          id={`body-${template.key}-${template.channel}`}
          className="field min-h-40"
          value={body}
          maxLength={limit}
          disabled={pending}
          onChange={(event) => {
            setBody(event.target.value)
            setPreview(null)
          }}
        />
      </Field>

      <VariableChips variables={template.variables} />

      <label className="flex items-center gap-2 text-sm">
        <input
          className="check"
          type="checkbox"
          checked={active}
          disabled={pending}
          onChange={(event) => setActive(event.target.checked)}
        />
        Usar este texto
      </label>
      {!active && (
        <p className="hint">
          Desligado, este canal deixa de ser usado para esta situação — a mensagem tenta o outro
          canal, se houver.
        </p>
      )}

      {preview && <PreviewPanel preview={preview} isEmail={isEmail} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" busy={pending} disabled={!dirty} onClick={save} busyLabel="Salvando…">
          Salvar
        </Button>
        <Button
          type="button"
          variant="ghost"
          busy={pending}
          onClick={runPreview}
          busyLabel="Gerando…"
        >
          Ver como fica
        </Button>
        {!template.isDefault && (
          <Button
            type="button"
            variant="ghost"
            className="text-danger"
            busy={pending}
            onClick={reset}
            busyLabel="Restaurando…"
          >
            Voltar ao texto padrão
          </Button>
        )}
        {saved && !dirty && <span className="text-sm text-success">Salvo.</span>}
      </div>
    </div>
  )
}

/**
 * As marcações que este texto aceita.
 *
 * Ficam à vista porque a validação é uma allowlist: escrever `{{tutor.sobrenome}}` num
 * texto que só conhece `{{tutor.nome}}` é recusado na gravação, e descobrir isso
 * depois de escrever a frase inteira é o caminho mais longo até a mesma informação.
 */
function VariableChips({ variables }: { variables: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {variables.map((variable) => (
        <code key={variable} className="pill bg-black/5 px-2.5 py-1 text-xs text-muted">
          {`{{${variable}}}`}
        </code>
      ))}
    </div>
  )
}

function PreviewPanel({ preview, isEmail }: { preview: TemplatePreview; isEmail: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-3">
      <p className="hint">Com dados de exemplo</p>
      {isEmail && preview.subject && <p className="mt-2 text-sm font-medium">{preview.subject}</p>}
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{preview.body}</p>
      {preview.missing.length > 0 && (
        <p className="mt-3 text-sm text-danger">
          Sem valor de exemplo: {preview.missing.join(', ')}. Na mensagem real elas são preenchidas
          — aqui o buraco na frase mostra onde cada uma entra.
        </p>
      )}
    </div>
  )
}

/** Agrupa por chave preservando a ordem do catálogo, com o WhatsApp antes do e-mail. */
function groupByKey(templates: ResolvedTemplate[]): [string, ResolvedTemplate[]][] {
  const groups = new Map<string, ResolvedTemplate[]>()
  for (const template of templates) {
    const list = groups.get(template.key) ?? []
    list.push(template)
    groups.set(template.key, list)
  }
  return [...groups.entries()]
}
