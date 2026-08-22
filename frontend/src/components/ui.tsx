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
