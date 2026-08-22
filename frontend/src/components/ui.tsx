import type { ReactNode } from 'react'

/**
 * Peças de interface do sistema visual (`design/design-modelo.html`).
 *
 * Deliberadamente pequeno: só o que as telas desta entrega usam. Um kit maior sem
 * telas que o exercitem envelhece antes de ser usado.
 */

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1400px] px-2 pt-2 sm:px-4 sm:pt-4">
      <div className="shell flex min-h-[100svh] flex-col overflow-hidden">{children}</div>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-6 sm:p-8 ${className}`}>{children}</div>
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-6 w-9 items-center" aria-hidden="true">
        <span className="absolute left-0 h-6 w-6 rounded-full bg-shell" />
        <span className="absolute left-3.5 h-6 w-6 rounded-full bg-accent" />
      </span>
      <span className="font-semibold">PetShop AI</span>
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'danger'
}) {
  const tones = {
    neutral: 'bg-black/5 text-muted',
    accent: 'bg-accent-soft text-accent-ink',
    success: 'bg-success-soft text-success',
    danger: 'bg-danger-soft text-danger',
  } as const

  return (
    <span
      className={`pill inline-flex items-center px-3 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

interface FieldProps {
  label: string
  htmlFor: string
  error?: string | undefined
  hint?: string | undefined
  children: ReactNode
}

export function Field({ label, htmlFor, error, hint, children }: FieldProps) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="error-text mt-1.5" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="hint mt-1.5">{hint}</p>
      ) : null}
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div
      className="rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger"
      role="alert"
      aria-live="polite"
    >
      {message}
    </div>
  )
}

/** Barra de progresso do wizard: o usuário precisa ver quanto falta. */
export function StepProgress({
  current,
  total,
  titles,
}: {
  current: number
  total: number
  titles: Record<number, string>
}) {
  return (
    <div>
      <div className="flex items-center gap-2" role="list">
        {Array.from({ length: total }, (_, index) => index + 1).map((step) => (
          <div
            key={step}
            role="listitem"
            aria-current={step === current ? 'step' : undefined}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              step < current ? 'bg-shell' : step === current ? 'bg-accent' : 'bg-black/10'
            }`}
          />
        ))}
      </div>
      <p className="hint mt-3">
        Etapa {current} de {total} · {titles[current]}
      </p>
    </div>
  )
}

/** Cabeçalho de página com título, subtítulo e ações à direita. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="hint">{eyebrow}</p>}
        <h1 className="mt-1 text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
        {subtitle && <p className="hint mt-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Estado vazio. Distingue "não há nada ainda" de "a busca não achou": são situações
 * diferentes, e oferecer "cadastrar o primeiro" a quem só errou a busca é ruído.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="hint mt-2 max-w-sm">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: string; label: string }[]
  active: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onSelect(tab.id)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab.id === active
              ? 'border-accent text-ink'
              : 'border-transparent text-subtle hover:text-muted'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** Par rótulo/valor das telas de detalhe. */
export function DataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-3 last:border-b-0">
      <dt className="hint">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}
