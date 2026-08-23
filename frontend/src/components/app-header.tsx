import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'
import { Badge, Logo } from './ui'

/**
 * Cabeçalho das telas internas.
 *
 * Existe como componente, e não repetido em cada layout, porque a navegação é o que
 * dá ao produto a sensação de ser um lugar só. Duas cópias divergem na primeira
 * pressa — e a primeira coisa a divergir é qual item está marcado como ativo.
 */

type NavKey = 'inicio' | 'tutores' | 'pets' | 'configuracoes'

interface NavItem {
  key: NavKey
  href: '/dashboard' | '/tutores' | '/pets' | '/configuracoes'
  label: string
  /** Item que só existe para quem tem `tenant:read_settings`. */
  restricted?: boolean
}

const NAV: NavItem[] = [
  { key: 'inicio', href: '/dashboard', label: 'Início' },
  { key: 'tutores', href: '/tutores', label: 'Tutores' },
  { key: 'pets', href: '/pets', label: 'Pets' },
  { key: 'configuracoes', href: '/configuracoes', label: 'Configurações', restricted: true },
]

export interface AppHeaderProps {
  active: NavKey
  /** Dias restantes de teste; `null` fora do período de TRIAL. */
  trialDaysLeft?: number | null
  /**
   * `tenant:read_settings`. O menu não oferece o que a página recusaria: um link que
   * sempre devolve o usuário ao início é pior do que link nenhum.
   */
  canReadSettings?: boolean
}

export function AppHeader({
  active,
  trialDaysLeft = null,
  canReadSettings = false,
}: AppHeaderProps) {
  const items = NAV.filter((item) => !item.restricted || canReadSettings)

  return (
    <header className="flex items-center justify-between border-b border-line px-6 py-5 sm:px-10">
      <div className="flex items-center gap-8">
        <Link href="/dashboard" aria-label="Ir para o início">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === active ? 'page' : undefined}
              className={`btn btn-ghost px-3 py-1.5 ${
                item.key === active ? 'bg-black/5 text-ink' : ''
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-4">
        {trialDaysLeft !== null && (
          <Badge tone="accent">
            {trialDaysLeft === 0
              ? 'Último dia de teste'
              : `${trialDaysLeft} ${trialDaysLeft === 1 ? 'dia' : 'dias'} de teste`}
          </Badge>
        )}
        <UserButton />
      </div>
    </header>
  )
}

/** Dias inteiros até o fim do teste, nunca negativo. */
export function trialDaysLeftOf(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null
  const remaining = new Date(trialEndsAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)))
}
