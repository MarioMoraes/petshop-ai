import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react'
import { titleCase } from '@petshop/shared-types'
import { SpinnerIcon, type IconTone } from './icons'

/**
 * Peças de interface do sistema visual (`design/design-modelo.html`).
 *
 * Deliberadamente pequeno: só o que as telas desta entrega usam. Um kit maior sem
 * telas que o exercitem envelhece antes de ser usado.
 */

/**
 * O título em Title Case (`titleCase` de `shared-types/text.ts`) — a regra de todo
 * título do sistema.
 *
 * Aplicada **na peça**, e não em cada chamada: são centenas de títulos, muitos montados
 * com dado ("Excluir Rex?"), e uma regra que dependesse de cada tela lembrar dela já
 * nasceria com exceções. Só texto é convertido; um título em JSX — nome com selo ao lado
 * — passa como veio, e quem o monta aplica `titleCase` no trecho de texto.
 */
export function titulo(node: ReactNode): ReactNode {
  return typeof node === 'string' ? titleCase(node) : node
}

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

/**
 * A marca do topo da lateral.
 *
 * `name` troca o nome do produto pelo do estabelecimento aberto: dentro do admin,
 * quem está ali já sabe qual sistema usa — o que precisa ver o tempo todo é em qual
 * petshop está mexendo. Fora do admin (entrada, convite, onboarding, portal) não há
 * tenant resolvido, e o padrão continua sendo "PetShop AI".
 */
export function Logo({ name }: { name?: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="relative flex h-6 w-9 shrink-0 items-center" aria-hidden="true">
        <span className="absolute left-0 h-6 w-6 rounded-full bg-shell" />
        <span className="absolute left-3.5 h-6 w-6 rounded-full bg-accent" />
      </span>
      <span className="truncate font-semibold">{name || 'PetShop AI'}</span>
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
    <span className={`pill inline-flex items-center px-3 py-1 text-xs font-medium ${tones[tone]}`}>
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
        <h1 className="mt-1 text-3xl font-semibold leading-tight sm:text-4xl">{titulo(title)}</h1>
        {subtitle && <p className="hint mt-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Estado vazio. Distingue "não há nada ainda" de "a busca não achou": são situações
 * diferentes, e oferecer "cadastrar o primeiro" a quem só errou a busca é ruído.
 *
 * O chip no topo é o do domínio, com o mesmo tom do menu lateral: é a primeira tela que
 * um estabelecimento novo vê em cada área, e só texto num cartão branco lia como página
 * inacabada. Para o "não respondeu" e o "sem acesso" o ícone é o do problema
 * (`AlertTriangleIcon`, `ShieldCheckIcon`) e não o da área — um estado de erro com o
 * mesmo rosto do "ainda não há nada" faria os dois se confundirem num relance.
 *
 * O halo em volta do chip é um anel de 8px na cor clara do próprio tom: dá ao ícone o
 * peso de figura central sem precisar de ilustração.
 *
 * `icon` é opcional no tipo porque o Portal e o console da plataforma também usam a
 * peça e têm linguagem própria; nas telas do Admin ele é obrigatório, e quem cobra é
 * `lib/estados-vazios.test.ts`.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  tone,
}: {
  title: string
  description: string
  action?: ReactNode
  icon?: ReactNode
  /** O tom do domínio. Sem tom, o chip cai no neutro com traço no acento — o do erro. */
  tone?: IconTone
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      {icon && <span className={`icon-chip empty-chip ${tone ?? ''}`}>{icon}</span>}
      <h3 className={`text-lg font-semibold ${icon ? 'mt-6' : ''}`}>{titleCase(title)}</h3>
      <p className="hint mt-2 max-w-sm">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

/**
 * Abas em trilho: a ativa é uma pastilha branca levantada, a mesma física do
 * `.nav-item-active` e do polegar do `Segmented` (regra 6 de
 * `docs/design-formularios.md`). Era um sublinhado coral — a única peça do sistema em
 * que o ativo não era levante, e o acento aparecendo onde não precisa.
 *
 * Não desliza como o `Segmented`: aqui os rótulos têm larguras diferentes e trazem
 * contador, e medir cada aba para mover um polegar custaria mais que o efeito vale.
 *
 * O trilho rola na horizontal quando não cabe — o pet tem seis abas e as
 * Configurações nove —, em vez de quebrar em duas linhas. As setas do teclado andam
 * entre as abas, como o padrão de `tablist` pede.
 */
export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: string; label: string; count?: number }[]
  active: string
  onSelect: (id: string) => void
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const index = tabs.findIndex((tab) => tab.id === active)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(index + step + tabs.length) % tabs.length]
    if (!next) return
    event.preventDefault()
    onSelect(next.id)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  return (
    <div className="tabs-rail" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className="tab"
          >
            {titleCase(tab.label)}
            {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
          </button>
        )
      })}
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
          <h2 className="section-title">{titleCase(title)}</h2>
        </div>
      </div>
      {description && <p className="hint mt-2">{description}</p>}
    </div>
  )
}

/**
 * Cabeçalho de cartão de leitura: o `SectionHead` do cartão branco.
 *
 * Os cartões de conteúdo abriam com um `<h3>` solto em negrito, e o cartão de
 * formulário ao lado abria com chip e Título 4 — duas gramáticas na mesma ficha. Aqui é
 * a mesma peça sem o olho-de-boi (cartão de leitura não é sequência numerada) e com um
 * slot à direita para a ação ou o filtro do cartão.
 *
 * `h3` e não `h2`: dentro de uma ficha o `h1` é o nome do registro e o `h2` é a aba.
 */
export function CardHead({
  icon,
  tone,
  title,
  description,
  action,
}: {
  icon: ReactNode
  tone: IconTone
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="section-head min-w-0">
          <span className={`icon-chip icon-chip-sm ${tone}`}>{icon}</span>
          <h3 className="section-title min-w-0">{titulo(title)}</h3>
        </div>
        {action}
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
        {/*
          `flex-1`: o rótulo ocupa a linha inteira depois da caixa.
          Sem isso ele encolhia até o conteúdo, e um rótulo que alinha preço à direita
          com `justify-between` não tinha espaço a repartir — o valor colava no nome em
          vez de ir para a margem. Para rótulo de texto simples nada muda: o texto já
          quebrava na mesma largura.
        */}
        <span className="min-w-0 flex-1">
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
 * Botão — e, quando `busy`, o botão que está esperando o backend.
 *
 * Antes desta peça cada tela resolvia a espera sozinha, com `disabled={pending}` e uma
 * troca de rótulo. Faltavam duas coisas, e as duas custam caro no balcão:
 *
 *   · **o anel girando.** O rótulo trocado é a informação; o giro é o que se enxerga sem
 *     ler, e ler não é o que alguém faz enquanto espera.
 *   · **a diferença entre "espere" e "não pode".** `.btn:disabled` derruba a peça para 45%
 *     e dessatura. É a cara certa para o botão que ainda não pode ser clicado, e é a
 *     errada para o que já foi: `aria-busy` desvia dessa regra em `globals.css` (§Espera)
 *     e mantém o botão de pé, opaco, com o cursor de relógio.
 *
 * `busyLabel` é opcional e é o que sobra sob `prefers-reduced-motion`, onde o anel se
 * esconde — sem ele, quem pediu menos movimento fica sem sinal nenhum. Escreva-o sempre
 * que o botão gravar algo.
 *
 * O irmão que navega em vez de gravar é o `<ButtonLink>` (`components/links.tsx`), que
 * lê a espera do próprio roteador.
 */
export function Button({
  children,
  variant = 'primary',
  busy = false,
  busyLabel,
  icon,
  className = '',
  type = 'button',
  disabled = false,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: 'primary' | 'accent' | 'ghost'
  /** A ação está no ar. Trava o botão, gira o anel e troca o rótulo por `busyLabel`. */
  busy?: boolean
  busyLabel?: string
  /**
   * Glifo à esquerda do rótulo. Existindo, é ele que dá lugar ao anel — sem ele o botão
   * ganharia 22px de largura no instante do clique e empurraria o vizinho da barra.
   */
  icon?: ReactNode
  className?: string
}) {
  return (
    <button
      {...rest}
      type={type}
      className={`btn btn-${variant} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {icon ? (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
          {busy ? <SpinnerIcon /> : icon}
        </span>
      ) : (
        busy && <SpinnerIcon />
      )}
      {busy && busyLabel ? busyLabel : children}
    </button>
  )
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
