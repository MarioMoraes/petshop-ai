'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  SITE_PUBLISH_REQUIREMENT_LABELS,
  type SitePreview,
  type SitePublishRequirement,
} from '@petshop/shared-types'
import { Alert, Button, Card, Choice, Field, FormError, SectionHead } from '@/components/ui'
import { useToast } from '@/components/toast'
import { AlertTriangleIcon, GlobeIcon, ImageIcon, SettingsIcon } from '@/components/icons'
import {
  publishSiteAction,
  unpublishSiteAction,
  updateSiteContentAction,
  type ActionResult,
} from './actions'

/**
 * Configuração do site.
 *
 * Cada bloco salva sozinho, como em `/configuracoes`, no Taxi Dog e no CRM: campo de
 * texto salva no `onBlur` e só quando o valor mudou; caixa de seleção salva no
 * `onChange`. Um "salvar tudo" faria quem só queria corrigir o aviso da faixa
 * reenviar junto o "sobre nós" e os metadados de busca.
 */

interface Props {
  preview: SitePreview
}

export function SiteForm({ preview }: Props) {
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

      <Publication preview={preview} onError={setError} onSaved={setSaved} />
      <Texts preview={preview} onError={setError} onSaved={setSaved} />
      <Showcase preview={preview} onError={setError} onSaved={setSaved} />
      <Seo preview={preview} onError={setError} onSaved={setSaved} />
    </div>
  )
}

interface BlockProps {
  preview: SitePreview
  onError: (message: string | null) => void
  onSaved: (message: string | null) => void
}

/**
 * A chave geral: no ar ou fora do ar.
 *
 * Fica sozinha, no topo, e não junto dos ajustes, porque é de outra ordem — os demais
 * campos afinam **como** a página se apresenta; este decide **se** ela existe para o
 * mundo. Fora do ar, o endereço responde 404: não há página de "em construção", que só
 * anunciaria ao visitante que ele voltou cedo demais.
 */
function Publication({ preview, onError, onSaved }: BlockProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [missing, setMissing] = useState<SitePublishRequirement[]>(
    preview.missing as SitePublishRequirement[],
  )

  const address = preview.site.seo.canonicalUrl

  function run(action: () => Promise<ActionResult<unknown>>, message: string) {
    onError(null)
    onSaved(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        // O 422 da publicação carrega a lista do que falta; guardá-la é o que permite
        // apontar cada item em vez de repetir a frase do servidor.
        if (result.missing) setMissing(result.missing as SitePublishRequirement[])
        onError(result.message)
        return
      }
      setMissing([])
      onSaved(message)
      router.refresh()
    })
  }

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionHead
            icon={<GlobeIcon />}
            tone="icon-metric"
            eyebrow="Publicação"
            title={preview.published ? 'A página está no ar' : 'A página está fora do ar'}
            description={
              preview.published
                ? 'Quem abrir o endereço abaixo vê o site do estabelecimento.'
                : 'Enquanto não publicar, o endereço responde como página inexistente.'
            }
          />
        </div>

        <Button
          type="button"
          busy={pending}
          onClick={() =>
            preview.published
              ? run(unpublishSiteAction, 'O site saiu do ar.')
              : run(publishSiteAction, 'O site está no ar.')
          }
          busyLabel="Salvando…"
        >
          {preview.published ? 'Tirar do ar' : 'Publicar'}
        </Button>
      </div>

      {missing.length > 0 && (
        <Alert
          tone="accent"
          icon={<AlertTriangleIcon />}
          title="Falta preencher antes de publicar"
          role="status"
        >
          <ul className="ml-4 list-disc space-y-1">
            {missing.map((item) => (
              <li key={item}>{SITE_PUBLISH_REQUIREMENT_LABELS[item]}</li>
            ))}
          </ul>
          <p className="mt-2">
            Endereço e telefone ficam em{' '}
            <Link href="/configuracoes/estabelecimento" className="underline">
              Configurações
            </Link>
            ; os serviços, em{' '}
            <Link href="/agenda/servicos" className="underline">
              Agenda → Serviços
            </Link>
            .
          </p>
        </Alert>
      )}

      <div className="rounded-xl border border-line bg-white px-4 py-3">
        <p className="hint">Endereço do site</p>
        <p className="mt-0.5 break-all text-sm font-medium">
          {preview.published ? (
            <a href={address} target="_blank" rel="noreferrer" className="hover:underline">
              {address}
            </a>
          ) : (
            address
          )}
        </p>
      </div>
    </Card>
  )
}

/**
 * Os quatro textos livres.
 *
 * Quatro é escolha, não limitação: cada campo a mais é um campo que fica
 * desatualizado. Tudo o mais na página — nome, cores, endereço, telefone, horário,
 * serviços — vem do que o petshop já mantém em outro lugar, e não tem cópia aqui.
 */
function Texts({ preview, onError, onSaved }: BlockProps) {
  const save = useFieldSaver(onError, onSaved)
  const content = preview.site.content

  return (
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<GlobeIcon />}
        tone="icon-metric"
        eyebrow="Textos"
        title="O que a página diz"
        description="Deixe em branco e a página usa um texto montado do seu cadastro."
      />

      <Field
        label="Chamada"
        htmlFor="headline"
        hint="A primeira frase, em destaque. Até 120 caracteres."
      >
        <input
          id="headline"
          className="field"
          maxLength={120}
          defaultValue={content.headline ?? ''}
          onBlur={(event) =>
            save(
              content.headline ?? '',
              event.target.value,
              (value) => ({ headline: value }),
              'Chamada',
            )
          }
        />
      </Field>

      <Field
        label="Sobre nós"
        htmlFor="about"
        hint="Um parágrafo sobre o estabelecimento. Até 800 caracteres."
      >
        <textarea
          id="about"
          className="field"
          rows={4}
          maxLength={800}
          defaultValue={content.about ?? ''}
          onBlur={(event) =>
            save(content.about ?? '', event.target.value, (value) => ({ about: value }), 'Texto')
          }
        />
      </Field>

      <Field
        label="Aviso temporário"
        htmlFor="notice"
        hint="Aparece como faixa no topo — “fechados dia 25”. Apague para tirar a faixa."
      >
        <input
          id="notice"
          className="field"
          maxLength={200}
          defaultValue={content.notice ?? ''}
          onBlur={(event) =>
            save(content.notice ?? '', event.target.value, (value) => ({ notice: value }), 'Aviso')
          }
        />
      </Field>

      <Field label="Rodapé" htmlFor="footerNote" hint="A linha do pé da página.">
        <input
          id="footerNote"
          className="field"
          maxLength={200}
          defaultValue={content.footerNote ?? ''}
          onBlur={(event) =>
            save(
              content.footerNote ?? '',
              event.target.value,
              (value) => ({ footerNote: value }),
              'Rodapé',
            )
          }
        />
      </Field>
    </Card>
  )
}

/** O que a página mostra: preços e formulário. */
function Showcase({ preview, onError, onSaved }: BlockProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const content = preview.site.content

  function toggle(patch: { showPrices?: boolean; leadFormEnabled?: boolean }, message: string) {
    onError(null)
    onSaved(null)
    startTransition(async () => {
      const result = await updateSiteContentAction(patch)
      if (!result.ok) {
        onError(result.message)
        return
      }
      onSaved(message)
      router.refresh()
    })
  }

  const shown = preview.site.services.length
  const priced = preview.site.services.filter((service) => service.fromPriceCents !== null).length

  const summary =
    shown === 0
      ? 'Nenhum serviço aparece no site — sem eles a página não diz o que o petshop faz.'
      : `${shown === 1 ? '1 serviço aparece' : `${shown} serviços aparecem`} no site${
          priced > 0 ? `, ${priced === 1 ? '1 com' : `${priced} com`} faixa de preço` : ''
        }.`

  return (
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<ImageIcon />}
        tone="icon-metric"
        eyebrow="Vitrine"
        title="O que a página mostra"
        description={summary}
      />

      <Choice
        label="Mostrar faixa de preço"
        description="Cada serviço aparece com “a partir de”, usando o menor preço da tabela. O valor exato depende do porte e do pelo, e o site não sabe qual é o pet."
        checked={content.showPrices}
        disabled={pending}
        onChange={(checked) =>
          toggle(
            { showPrices: checked },
            checked ? 'Os preços aparecem no site.' : 'Os preços saíram do site.',
          )
        }
      />

      <Choice
        label="Aceitar mensagens pelo site"
        description="Um formulário de contato no fim da página. O que chega vai para a fila de Contatos."
        checked={content.leadFormEnabled}
        disabled={pending}
        onChange={(checked) =>
          toggle(
            { leadFormEnabled: checked },
            checked ? 'O formulário está no site.' : 'O formulário saiu do site.',
          )
        }
      />

      <p className="hint">
        Para tirar um serviço da vitrine sem desativá-lo, use a opção “mostrar no site” em{' '}
        <Link href="/agenda/servicos" className="underline">
          Agenda → Serviços
        </Link>
        .
      </p>
    </Card>
  )
}

/** O que o Google mostra. Vazio volta ao derivado — nunca fica em branco. */
function Seo({ preview, onError, onSaved }: BlockProps) {
  const save = useFieldSaver(onError, onSaved)
  const content = preview.site.content
  const seo = preview.site.seo

  return (
    <Card tone="soft" className="space-y-5">
      <SectionHead
        icon={<SettingsIcon />}
        tone="icon-metric"
        eyebrow="Busca"
        title="Como a página aparece no Google"
        description="Em branco, o sistema monta a partir do nome, da cidade e dos serviços."
      />

      <Field label="Título" htmlFor="seoTitle" hint={`Até 60 caracteres. Hoje: “${seo.title}”`}>
        <input
          id="seoTitle"
          className="field"
          maxLength={60}
          defaultValue={content.seoTitle ?? ''}
          onBlur={(event) =>
            save(
              content.seoTitle ?? '',
              event.target.value,
              (value) => ({ seoTitle: value }),
              'Título',
            )
          }
        />
      </Field>

      <Field
        label="Descrição"
        htmlFor="seoDescription"
        hint={`Até 160 caracteres. Hoje: “${seo.description}”`}
      >
        <textarea
          id="seoDescription"
          className="field"
          rows={3}
          maxLength={160}
          defaultValue={content.seoDescription ?? ''}
          onBlur={(event) =>
            save(
              content.seoDescription ?? '',
              event.target.value,
              (value) => ({ seoDescription: value }),
              'Descrição',
            )
          }
        />
      </Field>
    </Card>
  )
}

/**
 * Salva um campo de texto no `onBlur`, **e só quando o valor mudou**.
 *
 * Sem a comparação, sair de um campo que ninguém tocou dispararia um PATCH — e uma
 * tela de configuração com seis campos viraria seis gravações a cada visita.
 *
 * String vazia vira `null`: apagar o aviso da faixa precisa tirar a faixa, e não
 * gravar um aviso em branco.
 */
function useFieldSaver(
  onError: (message: string | null) => void,
  onSaved: (message: string | null) => void,
) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  return function save(
    current: string,
    next: string,
    toPatch: (value: string | null) => Record<string, unknown>,
    label: string,
  ) {
    const trimmed = next.trim()
    if (trimmed === current.trim()) return

    onError(null)
    onSaved(null)
    startTransition(async () => {
      const result = await updateSiteContentAction(toPatch(trimmed === '' ? null : trimmed))
      if (!result.ok) {
        onError(result.message)
        return
      }
      onSaved(`${label} salvo.`)
      router.refresh()
    })
  }
}
