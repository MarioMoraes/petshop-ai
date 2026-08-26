/**
 * Ícones do sistema.
 *
 * Traçados do Lucide, o mesmo conjunto que `design/design-modelo.html` usa, inline em
 * vez de vindos de pacote: são poucos, e uma dependência de biblioteca de ícones
 * inteira para isso pesaria mais que o benefício. `stroke-width: 1.5` é o do design.
 */

const BASE = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/**
 * Tom do ícone — a família de cor do tipo que ele representa (`globals.css`, §Tom do
 * ícone). Os traços continuam em `currentColor`: quem pinta é quem embrulha, com
 * `.icon-chip` no cartão ou `.icon-tint` no menu. É o que mantém o mesmo ícone
 * utilizável nos dois lugares sem duas versões dele.
 *
 * O tom é intrínseco ao ícone e não à tela: o calendário é azul na Agenda, no painel e
 * onde mais aparecer. Cada função abaixo declara o seu logo acima, e é dali que o valor
 * deve ser copiado para o `className` — não do fundo do arquivo, para não divergirem.
 */
export type IconTone =
  | 'icon-brand'
  | 'icon-people'
  | 'icon-pet'
  | 'icon-time'
  | 'icon-money'
  | 'icon-metric'
  | 'icon-health'
  | 'icon-system'

/** Tom: `icon-people`. */
export function UsersIcon() {
  return (
    <svg {...BASE}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

/** Tom: `icon-pet`. */
export function PawPrintIcon() {
  return (
    <svg {...BASE}>
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </svg>
  )
}

/** Tom: `icon-brand`. */
export function HomeIcon() {
  return (
    <svg {...BASE}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  )
}

/** Tom: `icon-system`. */
export function SettingsIcon() {
  return (
    <svg {...BASE}>
      <path d="M12.9 3h-1.8a1.6 1.6 0 0 0-1.6 1.4l-.1.9a7 7 0 0 0-1.3.8l-.9-.4a1.6 1.6 0 0 0-2 .7l-.9 1.5a1.6 1.6 0 0 0 .4 2l.7.6a7 7 0 0 0 0 1.5l-.7.6a1.6 1.6 0 0 0-.4 2l.9 1.5a1.6 1.6 0 0 0 2 .7l.9-.4q.6.5 1.3.8l.1.9a1.6 1.6 0 0 0 1.6 1.4h1.8a1.6 1.6 0 0 0 1.6-1.4l.1-.9a7 7 0 0 0 1.3-.8l.9.4a1.6 1.6 0 0 0 2-.7l.9-1.5a1.6 1.6 0 0 0-.4-2l-.7-.6a7 7 0 0 0 0-1.5l.7-.6a1.6 1.6 0 0 0 .4-2l-.9-1.5a1.6 1.6 0 0 0-2-.7l-.9.4a7 7 0 0 0-1.3-.8l-.1-.9A1.6 1.6 0 0 0 12.9 3" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

/** Tom: `icon-metric`. */
export function TrendingUpIcon() {
  return (
    <svg {...BASE}>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </svg>
  )
}

/** Tom: `icon-time`. */
export function CalendarIcon() {
  return (
    <svg {...BASE}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

/** Tom: `icon-money`. */
export function WalletIcon() {
  return (
    <svg {...BASE}>
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  )
}

/** Tom: `icon-health`. */
export function HeartPulseIcon() {
  return (
    <svg {...BASE}>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.5 13H9l.5-1 2 4.5 2-7 1.5 3.5h5.2" />
    </svg>
  )
}
