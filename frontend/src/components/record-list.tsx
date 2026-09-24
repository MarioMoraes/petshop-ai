import type { ReactNode } from 'react'
import Link from 'next/link'
import type { PetAlert } from '@petshop/shared-types'
import type { Route } from 'next'
import { ChevronRightIcon } from './icons'
import { ButtonLink, LinkSpinner } from './links'

/**
 * A listagem de cadastro — `/pets` e `/tutores` são a mesma tela com dados diferentes.
 *
 * Uma grade de cartões brancos (cartão de conteúdo, não ficha: regra 1 de
 * `docs/design-formularios.md`), cada um com três faixas de função fixa:
 *
 *   · **cabeça** — o rosto (foto do pet, iniciais do tutor), o nome e os selos de
 *     estado, e uma linha de meta que desambigua (RN-16: cinco "Mel" é normal);
 *   · **corpo** — opcional, o que pede atenção antes de abrir a ficha: alertas do
 *     prontuário, etiquetas;
 *   · **pé** — a relação com o outro cadastro (o responsável do pet, os pets do tutor)
 *     e, à direita, o número que interessa ao balcão.
 *
 * Grade e não pilha de linhas porque a foto é o que identifica o pet mais rápido, e
 * numa linha de 64px de altura ela não passava de um selo. Em telas estreitas a grade
 * volta a ser uma coluna só, e o cartão continua lendo de cima para baixo.
 */

export function RecordGrid({ children }: { children: ReactNode }) {
  return <ul className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">{children}</ul>
}

export function RecordCard<T extends string>({
  href,
  avatar,
  title,
  badges,
  meta,
  children,
  footer,
}: {
  href: Parameters<typeof Link<T>>[0]['href']
  avatar: ReactNode
  title: string
  /** Selos de estado ao lado do nome — Inativo, Falecido, Cadastro incompleto. */
  badges?: ReactNode
  meta?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <li>
      <Link href={href} className="card card-interactive record-card">
        <div className="flex items-start gap-4">
          {avatar}
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="truncate text-base font-semibold leading-6">{title}</p>
            {meta && <p className="hint mt-0.5 truncate">{meta}</p>}
            {badges && <div className="mt-2 flex flex-wrap gap-1.5">{badges}</div>}
          </div>
          {/* O chevron vira o giro quando o cartão é clicado — a ficha custa uma ida ao servidor. */}
          <LinkSpinner size={16} className="menu-chevron mt-1 shrink-0">
            <ChevronRightIcon />
          </LinkSpinner>
        </div>

        {children && <div className="flex flex-wrap gap-1.5">{children}</div>}

        {footer && <div className="record-foot">{footer}</div>}
      </Link>
    </li>
  )
}

/**
 * Um item do pé do cartão: glifo pequeno no tom do domínio e o texto.
 *
 * O glifo é o da relação, não do cartão — no pet, as pessoas; no tutor, a patinha —,
 * e por isso leva o tom do outro domínio. É o que faz o pé ler como "leva a outro
 * cadastro" sem precisar de rótulo.
 */
export function RecordFact({
  icon,
  tone,
  children,
}: {
  icon: ReactNode
  tone: string
  children: ReactNode
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`record-fact-icon ${tone}`}>{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

/** Iniciais num círculo — o rosto de quem não tem foto: o tutor. */
export function InitialsAvatar({
  name,
  tone,
  size = 'md',
}: {
  name: string
  tone: string
  /** `md` (48px) na listagem, `lg` (64px) na ficha — os mesmos da `PetAvatar`. */
  size?: 'md' | 'lg'
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 2 || /^[A-ZÀ-Ý]/.test(part))
    .map((part) => part[0])
    .filter(Boolean)
  const text = (
    initials.length > 1 ? `${initials[0]}${initials[initials.length - 1]}` : (initials[0] ?? '?')
  ).toUpperCase()
  const box = size === 'lg' ? 'h-16 w-16 text-lg' : 'h-12 w-12 text-sm'

  return (
    <span
      aria-hidden
      className={`${tone} ${box} flex shrink-0 items-center justify-center rounded-full bg-[var(--icon-soft)] font-semibold tracking-wide text-[var(--icon)] shadow-[0_0_0_1px_var(--icon-ring)_inset]`}
    >
      {text}
    </span>
  )
}

/**
 * O alerta do prontuário que cabe num selo: o mais grave, com "+N" quando há outros.
 * O backend já entrega `alerts[]` ordenado por gravidade, do mais grave para o menos.
 */
export function topAlert(alerts: PetAlert[]): { label: string; critical: boolean } | null {
  const first = alerts[0]
  if (!first) return null
  const rest = alerts.length - 1
  return {
    label: rest > 0 ? `${first.label} +${rest}` : first.label,
    critical: first.severity === 'HIGH' || first.severity === 'CRITICAL',
  }
}

/** Paginação das listagens: a mesma nos dois cadastros, com os filtros preservados. */
export function Pagination({
  basePath,
  params,
  page,
  totalPages,
}: {
  basePath: '/pets' | '/tutores'
  params: Record<string, string | undefined>
  page: number
  totalPages: number
}) {
  if (totalPages <= 1) return null

  function hrefFor(target: number): Route {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== 'page') search.set(key, value)
    }
    search.set('page', String(target))
    return `${basePath}?${search.toString()}` as Route
  }

  return (
    <nav className="flex items-center justify-center gap-3" aria-label="Paginação">
      {page <= 1 ? (
        <span className="btn btn-primary opacity-40">Anterior</span>
      ) : (
        <ButtonLink href={hrefFor(page - 1)}>Anterior</ButtonLink>
      )}
      <span className="hint tabular-nums">
        Página {page} de {totalPages}
      </span>
      {page >= totalPages ? (
        <span className="btn btn-primary opacity-40">Próxima</span>
      ) : (
        <ButtonLink href={hrefFor(page + 1)}>Próxima</ButtonLink>
      )}
    </nav>
  )
}
