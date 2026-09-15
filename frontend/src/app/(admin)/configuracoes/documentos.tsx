'use client'

import { useState, useTransition } from 'react'
import {
  TERM_KINDS,
  TERM_KIND_LABELS,
  type TermKind,
  type TermVersionView,
} from '@petshop/shared-types'
import { Alert, Button, Card, Field, FormError, SectionHead } from '@/components/ui'
import { Modal } from '@/components/modal'
import { AlertTriangleIcon, DocumentIcon } from '@/components/icons'
import { TextoDoTermo } from '@/components/term-text'
import { publishTermVersionAction } from './actions'

/**
 * Os termos do estabelecimento (MOD-DOC-06).
 *
 * A tela existe por causa de uma ausência: até aqui o sistema registrava o aceite dos
 * termos com IP, carimbo de tempo e número de versão — de um texto que não existia em
 * lugar nenhum. O tutor não tinha como reler o que aceitou, e o petshop não tinha como
 * mostrar o que apresentou.
 *
 * **Não há edição, e é o ponto da tela.** Uma versão publicada tem aceites pendurados
 * nela; corrigir o texto seria reescrever o contrato de todo mundo que já assinou. O
 * botão publica a **próxima** versão, e a tela mostra quantos aceites cada uma carrega
 * justamente para que isso não pareça arbitrário.
 *
 * Cartão branco e não `tone="soft"`: é lista para ler, e o formulário abre em `<Modal>` —
 * regra 1 e regra 8 de `docs/design-formularios.md`.
 */
export function Documentos({
  versions,
  canEdit,
}: {
  versions: TermVersionView[]
  canEdit: boolean
}) {
  const [lista, setLista] = useState(versions)

  function acrescentar(nova: TermVersionView) {
    setLista((atual) => [nova, ...atual])
  }

  return (
    <div className="space-y-6">
      <Card>
        <SectionHead
          icon={<DocumentIcon />}
          tone="icon-system"
          eyebrow="Documentos"
          title="Termos apresentados ao cliente"
          description="O texto que o tutor lê antes de aceitar, e que sai impresso no papel do aceite. Publicar uma versão nova pede o aceite de novo a quem tinha aceitado a anterior."
        />

        <div className="mt-6 flex flex-col gap-6">
          {TERM_KINDS.map((kind) => (
            <TermoDoTipo
              key={kind}
              kind={kind}
              versions={lista.filter((item) => item.kind === kind)}
              canEdit={canEdit}
              onPublicado={acrescentar}
            />
          ))}
        </div>
      </Card>
    </div>
  )
}

function TermoDoTipo({
  kind,
  versions,
  canEdit,
  onPublicado,
}: {
  kind: TermKind
  versions: TermVersionView[]
  canEdit: boolean
  onPublicado: (version: TermVersionView) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [lendo, setLendo] = useState<TermVersionView | null>(null)

  const ordenadas = [...versions].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  const vigente = ordenadas.find((item) => item.current) ?? ordenadas[0]

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{TERM_KIND_LABELS[kind]}</p>
          <p className="hint">
            {vigente
              ? `Versão ${vigente.version} · publicada em ${data(vigente.publishedAt)} · ${contagem(vigente.acceptances)}`
              : 'Nenhuma versão publicada'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {vigente && (
            <Button type="button" className="h-9" onClick={() => setLendo(vigente)}>
              Ler
            </Button>
          )}
          {canEdit && (
            <Button type="button" className="h-9" onClick={() => setAberto(true)}>
              Publicar versão
            </Button>
          )}
        </div>
      </div>

      {ordenadas.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="hint">Versões anteriores:</span>
          {ordenadas
            .filter((item) => item.id !== vigente?.id)
            .map((item) => (
              <Button
                key={item.id}
                type="button"
                className="h-7 px-2 text-xs"
                onClick={() => setLendo(item)}
              >
                {item.version}
              </Button>
            ))}
        </div>
      )}

      <PublicarModal
        kind={kind}
        aberto={aberto}
        onClose={() => setAberto(false)}
        anterior={vigente ?? null}
        onPublicado={(nova) => {
          setAberto(false)
          onPublicado(nova)
        }}
      />

      <Modal
        open={lendo !== null}
        onClose={() => setLendo(null)}
        icon={<DocumentIcon />}
        tone="icon-system"
        eyebrow="Documentos"
        title={lendo?.title ?? ''}
        subtitle={
          lendo
            ? `Versão ${lendo.version} · publicada em ${data(lendo.publishedAt)} · ${contagem(lendo.acceptances)}`
            : ''
        }
        footer={
          <Button type="button" onClick={() => setLendo(null)}>
            Fechar
          </Button>
        }
      >
        {lendo && <TextoDoTermo body={lendo.body} />}
      </Modal>
    </div>
  )
}

function PublicarModal({
  kind,
  aberto,
  anterior,
  onClose,
  onPublicado,
}: {
  kind: TermKind
  aberto: boolean
  anterior: TermVersionView | null
  onClose: () => void
  onPublicado: (version: TermVersionView) => void
}) {
  const [version, setVersion] = useState(() => proximaVersao(anterior?.version))
  const [title, setTitle] = useState(anterior?.title ?? TERM_KIND_LABELS[kind])
  const [body, setBody] = useState(anterior?.body ?? '')
  const [erro, setErro] = useState<string | null>(null)
  const [campos, setCampos] = useState<Record<string, string>>({})
  const [salvando, startTransition] = useTransition()

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)
    setCampos({})

    startTransition(async () => {
      const resultado = await publishTermVersionAction({ kind, version, title, body })
      if (!resultado.ok) {
        setErro(resultado.message)
        setCampos(resultado.fieldErrors)
        return
      }
      onPublicado(resultado.data)
    })
  }

  return (
    <Modal
      open={aberto}
      onClose={onClose}
      busy={salvando}
      icon={<DocumentIcon />}
      tone="icon-system"
      eyebrow="Documentos"
      title={`Publicar ${TERM_KIND_LABELS[kind].toLowerCase()}`}
      subtitle="O texto publicado passa a ser o apresentado ao cliente. A versão anterior continua legível."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={salvando}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form={`termo-${kind}`}
            busy={salvando}
            disabled={body.trim().length < 50}
            busyLabel="Publicando…"
          >
            Publicar
          </Button>
        </>
      }
    >
      <form id={`termo-${kind}`} className="flex flex-col gap-5" onSubmit={enviar} noValidate>
        <FormError message={erro} />

        {anterior && anterior.acceptances > 0 && (
          <Alert
            tone="accent"
            icon={<AlertTriangleIcon />}
            title={`${contagem(anterior.acceptances)} na versão ${anterior.version}`}
            role="status"
          >
            Publicar uma versão nova não apaga a anterior — ela continua provando o que foi aceito.
            Quem aceitou a antiga passa a aparecer como pendente de renovação, e a equipe recolhe o
            aceite novo no próximo atendimento.
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <Field label="Versão" htmlFor={`versao-${kind}`} error={campos.version}>
            <input
              id={`versao-${kind}`}
              className="field"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              inputMode="decimal"
              maxLength={20}
              required
            />
          </Field>

          <Field label="Título" htmlFor={`titulo-${kind}`} error={campos.title}>
            <input
              id={`titulo-${kind}`}
              className="field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
            />
          </Field>
        </div>

        <Field
          label="Texto do termo"
          htmlFor={`corpo-${kind}`}
          error={campos.body}
          hint="Use ## para título de seção, - para item de lista e **negrito** para o que precisa saltar. O resto vira parágrafo."
        >
          <textarea
            id={`corpo-${kind}`}
            className="field font-mono text-xs"
            rows={16}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={40000}
            required
          />
        </Field>

        {body.trim().length >= 50 && (
          <div>
            <p className="section-eyebrow">Como o cliente vê</p>
            <div className="mt-2 rounded-xl border border-line p-4">
              <TextoDoTermo body={body} />
            </div>
          </div>
        )}
      </form>
    </Modal>
  )
}

/** `1.0` → `2.0`. A minor fica a cargo de quem digita: correção de vírgula não é versão. */
function proximaVersao(atual: string | undefined): string {
  const maior = Number(atual?.split('.')[0] ?? 0)
  return `${Number.isFinite(maior) ? maior + 1 : 2}.0`
}

function contagem(aceites: number): string {
  if (aceites === 0) return 'nenhum aceite ainda'
  return aceites === 1 ? '1 aceite registrado' : `${aceites} aceites registrados`
}

function data(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}
