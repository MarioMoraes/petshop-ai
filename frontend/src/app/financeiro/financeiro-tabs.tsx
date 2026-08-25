'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Navegação entre as telas do financeiro.
 *
 * Links, não estado: cada aba é uma página do servidor com dados próprios, e trocar
 * de aba recarregando é o que mantém a listagem fresca depois de uma edição na outra.
 */

const TABS = [
  { href: '/financeiro/pacotes', label: 'Pacotes' },
  { href: '/financeiro/configuracoes', label: 'Políticas' },
] as const

export function FinanceiroTabs() {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1 border-b border-line" aria-label="Seções do financeiro">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors ${
              active
                ? 'border-accent font-medium text-fg'
                : 'border-transparent text-subtle hover:text-fg'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
