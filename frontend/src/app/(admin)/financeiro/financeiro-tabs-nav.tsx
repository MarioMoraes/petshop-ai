'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { titleCase } from '@petshop/shared-types'

/**
 * A faixa de abas do Financeiro, do lado do navegador: só ela precisa saber em que
 * rota se está. Quais abas aparecem é decisão do servidor (`financeiro-tabs.tsx`).
 *
 * Links, não estado: cada aba é uma página do servidor com dados próprios, e trocar
 * de aba recarregando é o que mantém a listagem fresca depois de uma edição na outra.
 */

export interface FinanceiroTab {
  href: '/financeiro/relatorios' | '/financeiro/configuracoes'
  label: string
}

export function FinanceiroTabsNav({ tabs }: { tabs: FinanceiroTab[] }) {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1 border-b border-line" aria-label="Seções do financeiro">
      {tabs.map((tab) => {
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
            {titleCase(tab.label)}
          </Link>
        )
      })}
    </nav>
  )
}
