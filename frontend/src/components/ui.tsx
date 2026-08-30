import type { ReactNode } from 'react'
import type { IconTone } from './icons'

/**
 * Peças de interface do sistema visual (`design/design-modelo.html`).
 *
 * Deliberadamente pequeno: só o que as telas desta entrega usam. Um kit maior sem
 * telas que o exercitem envelhece antes de ser usado.
 */

/**
 * `relative` para os blooms de `<Atmosphere />` terem a que se ancorar, e
 * `overflow-hidden` para eles pararem no raio do shell em vez de sangrarem na página.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1400px] px-2 pt-2 sm:px-4 sm:pt-4">
      <div className="shell relative flex min-h-[100svh] flex-col overflow-hidden">{children}</div>
    </div>
  )
}

/**
 * `tone="soft"` troca o branco chapado pelo gradiente cinza de `.card-soft`.
 *
 * É a ficha de formulário: onde o card não é fundo de leitura e sim a mesa em que
 * os campos estão apoiados, ele precisa ser de outra cor que os campos. Em card de
 * conteúdo — lista, detalhe, painel — o branco continua sendo o certo.
 */
export function Card({
  children,
  className = '',
  tone = 'default',
}: {
  children: ReactNode
  className?: string
  tone?: 'default' | 'soft'
}) {
  return (
    <div className={`card p-6 sm:p-8 ${tone === 'soft' ? 'card-soft' : ''} ${className}`}>
      {children}
    </div>
  )
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

/* ══════════════════════════════════════════════════════════════════════════
 * Formulário
 *
 * As peças que faltavam ao kit. Ver `globals.css` §Formulário para o porquê de
 * cada uma; aqui fica só a marcação e o contrato.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Cabeçalho de seção de formulário: chip do tipo, olho-de-boi e título em serifa.
 *
 * O `tone` é o do ícone (`icon-people`, `icon-metric`, …) e vem documentado no
 * próprio ícone — é de lá que deve ser copiado, para chip e glifo não divergirem.
 */
export function SectionHead({
  icon,
  tone,
  eyebrow,
  title,
  description,
}: {
  icon: ReactNode
  tone: IconTone
  eyebrow?: string
  title: string
  description?: string
}) {
  return (
    <div>
      <div className="section-head">
        <span className={`icon-chip icon-chip-sm ${tone}`}>{icon}</span>
        <div className="min-w-0">
          {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
          <h2 className="section-title">{title}</h2>
        </div>
      </div>
      {description && <p className="hint mt-2">{description}</p>}
    </div>
  )
}

/**
 * Controle segmentado com pastilha deslizante.
 *
 * A pastilha é um irmão absoluto das opções, e não um fundo aplicado à opção
 * ativa: é o que permite ela viajar entre as duas em vez de piscar de um lado
 * para o outro. Largura em `calc` sobre o número de opções porque o trilho tem
 * `0.25rem` de folga de cada lado e a conta precisa descontá-la uma vez só.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel: string
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  return (
    <div className="segment" role="group" aria-label={ariaLabel}>
      <span
        aria-hidden="true"
        className="segment-thumb"
        style={{
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segment-option"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Escolha de linha inteira: caixa de seleção com o rótulo dentro do alvo.
 *
 * `<label>` envolvendo o `<input>` dispensa o par `id`/`htmlFor` e faz a linha toda
 * ser clicável de graça — o que importa num balcão, onde ninguém mira 20px.
 */
export function Choice({
  label,
  description,
  checked,
  onChange,
  error,
  disabled = false,
}: {
  label: ReactNode
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
  error?: string | undefined
  disabled?: boolean
}) {
  return (
    <div>
      <label className={`option${disabled ? ' option-disabled' : ''}`}>
        <input
          type="checkbox"
          className="check mt-px"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="option-text block">{label}</span>
          {description && <span className="hint mt-0.5 block">{description}</span>}
        </span>
      </label>
      {error && (
        <p className="error-text mt-1 px-3.5" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Barra de ação que acompanha o rodapé da viewport num formulário longo. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>
}

/**
 * Aviso com âncora visual.
 *
 * `title` em peso 500 na cor do tom, corpo em `--color-muted`: o alerta grita uma
 * vez no título e volta ao tom de voz do resto da tela no detalhe. Aviso inteiro
 * na cor de perigo cansa antes de ser lido.
 */
export function Alert({
  tone,
  icon,
  title,
  children,
  role = 'alert',
}: {
  tone: 'danger' | 'accent'
  icon: ReactNode
  title: ReactNode
  children?: ReactNode
  /**
   * `alert` interrompe o leitor de tela na hora; `status` espera ele terminar a
   * frase. Aviso que não bloqueia salvar — peso fora da faixa do porte, por
   * exemplo — é `status`: interromper alguém para dizer "pode seguir assim" é
   * exatamente o uso que treina o usuário a ignorar avisos.
   */
  role?: 'alert' | 'status'
}) {
  return (
    <div className={`alert alert-${tone} rise`} role={role}>
      <span className="alert-icon">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-1.5 text-muted">{children}</div>}
      </div>
    </div>
  )
}
