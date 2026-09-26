import type { ReactNode } from 'react'
import Link from 'next/link'
import { titleCase } from '@petshop/shared-types'
import type { IconTone } from './icons'
import { CardHead } from './ui'

/**
 * O cabeçalho da ficha — `/tutores/[id]` e `/pets/[id]`.
 *
 * A ficha é a tela mais aberta do dia, e o que se procura nela quase nunca está na
 * aba: é "de quem é este pet", "quanto ele deve", "quando veio da última vez". Antes
 * isso estava no meio de dez linhas rótulo/valor da aba Dados, e o cabeçalho era só
 * o nome. Aqui o cartão responde num relance e as abas ficam para o detalhe.
 *
 * Cartão branco e não `card-soft`: é conteúdo para ler, não ficha com campos (regra 1
 * de `docs/design-formularios.md`). O rosto é o mesmo da listagem, maior — ao sair de
 * um cartão da grade e cair aqui, a foto é o que confirma que se abriu o registro certo.
 *
 * Os números ficam numa faixa com fios entre eles, e não em cartõezinhos: quatro
 * cartões dentro de um cartão virariam painel de indicadores, e isto é um registro.
 */

export interface HeroFact {
  label: string
  value: ReactNode
  /** Pinta o valor — a dívida em `danger`, o alerta grave idem. */
  tone?: 'danger' | 'success'
}

const FACT_TONES = { danger: 'text-danger', success: 'text-success' } as const

/** Classes literais para o Tailwind achar: a grade tem tantas colunas quantos os fatos. */
const FACT_COLUMNS: Record<number, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
}

export function RecordHero<T extends string>({
  back,
  avatar,
  title,
  badges,
  meta,
  chips,
  facts,
  actions,
}: {
  back: { href: Parameters<typeof Link<T>>[0]['href']; label: string }
  avatar: ReactNode
  title: string
  /** Selos de estado ao lado do nome — Inativo, Falecido, Cadastro incompleto. */
  badges?: ReactNode
  meta?: ReactNode
  /** Pílulas sob a meta — as etiquetas do tutor. */
  chips?: ReactNode
  facts: HeroFact[]
  actions?: ReactNode
}) {
  return (
    <div className="space-y-3">
      <Link href={back.href} className="hint inline-flex items-center gap-1 hover:text-ink">
        ← {back.label}
      </Link>

      <section className="card record-hero">
        <div className="flex flex-wrap items-start gap-5">
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-2xl font-semibold leading-tight sm:text-3xl">
                {titleCase(title)}
              </h1>
              {badges}
            </div>
            {meta && <p className="hint mt-1.5">{meta}</p>}
            {chips && <div className="mt-3 flex flex-wrap gap-1.5">{chips}</div>}
          </div>
          {/*
            No celular as ações descem para uma linha própria: ao lado do rosto elas
            espremiam o nome em duas linhas e empurravam os selos para uma terceira.
          */}
          {actions && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
              {actions}
            </div>
          )}
        </div>

        {facts.length > 0 && (
          <dl className={`hero-facts ${FACT_COLUMNS[facts.length] ?? 'sm:grid-cols-4'}`}>
            {facts.map((fact) => (
              <div key={fact.label} className="hero-fact">
                <dt className="section-eyebrow">{fact.label}</dt>
                <dd
                  className={`mt-1 truncate text-lg font-semibold tabular-nums ${
                    fact.tone ? FACT_TONES[fact.tone] : ''
                  }`}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  )
}

/**
 * Um grupo de dados da aba Dados — "Contato", "Documento", "Identificação".
 *
 * Dez linhas rótulo/valor numa coluna só liam como planilha: o olho não tinha onde
 * pousar. Agrupadas por assunto, em cartões lado a lado, cada grupo é achado pelo
 * título antes de ser lido. O cabeçalho é o `CardHead` de `components/ui.tsx`.
 */
export function DataGroup({
  icon,
  tone,
  title,
  className = '',
  children,
}: {
  icon: ReactNode
  tone: IconTone
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`card p-6 ${className}`}>
      <CardHead icon={icon} tone={tone} title={title} />
      <div className="mt-3">{children}</div>
    </section>
  )
}
