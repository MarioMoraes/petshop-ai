'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Navegação entre as telas do catálogo da agenda.
 *
 * São abas de verdade — links, não estado — porque cada uma é uma página do servidor
 * com os seus próprios dados. Trocar de aba recarregando é o que mantém a listagem
 * fresca depois de uma edição na outra.
 */

const TABS = [
  { href: '/agenda/dia', label: 'Dia' },
  { href: '/agenda/novo', label: 'Marcar' },
  { href: '/agenda/servicos', label: 'Serviços' },
  { href: '/agenda/profissionais', label: 'Profissionais' },
] as const

export function AgendaTabs() {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1 border-b border-line" aria-label="Seções da agenda">
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
