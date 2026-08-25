import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { UserButton } from '@clerk/nextjs'
import type { MeResponse, PermissionKey } from '@petshop/shared-types'
import { Atmosphere } from './atmosphere'
import { CalendarIcon, HomeIcon, PawPrintIcon, SettingsIcon, UsersIcon, WalletIcon } from './icons'
import { Badge, Logo } from './ui'

/**
 * Moldura das telas internas: menu lateral fixo, topbar e área de conteúdo.
 *
 * Existe como componente, e não repetido em cada layout, porque a navegação é o que
 * dá ao produto a sensação de ser um lugar só. Duas cópias divergem na primeira
 * pressa — e a primeira coisa a divergir é qual item está marcado como ativo.
 *
 * O menu é vertical: a lista de módulos ainda vai crescer (agenda, financeiro,
 * prontuário) e uma barra horizontal quebra ou vira scroll assim que passa de meia
 * dúzia de itens. Vertical, cada novo módulo é só mais uma linha.
 *
 * O conteúdo ocupa a página inteira, sem a moldura arredondada que antes o envolvia:
 * em telas de trabalho — listagem, formulário, tabela — a moldura só roubava largura
 * útil e criava uma segunda borda concorrendo com a dos cartões.
 */

type NavKey = 'inicio' | 'tutores' | 'pets' | 'agenda' | 'financeiro' | 'configuracoes'

interface NavItem {
  key: NavKey
  href: '/dashboard' | '/tutores' | '/pets' | '/agenda/dia' | '/financeiro/pacotes' | '/configuracoes'
  label: string
  icon: ReactNode
  /**
   * Permissão que o item exige. Cada módulo declara a sua, em vez de todos
   * dependerem de `tenant:read_settings` — o financeiro é a primeira área que a
   * recepção acessa sem ser configuração, e um gate único já não descreveria a
   * matriz do RBAC.
   */
  requires?: PermissionKey
}

const NAV: NavItem[] = [
  { key: 'inicio', href: '/dashboard', label: 'Início', icon: <HomeIcon /> },
  { key: 'tutores', href: '/tutores', label: 'Tutores', icon: <UsersIcon /> },
  { key: 'pets', href: '/pets', label: 'Pets', icon: <PawPrintIcon /> },
  {
    // A visão do dia é o destino: é a tela que a recepção abre de manhã e mantém
    // aberta. Serviços e profissionais são configuração, visitada de vez em quando.
    key: 'agenda',
    href: '/agenda/dia',
    label: 'Agenda',
    icon: <CalendarIcon />,
    requires: 'tenant:read_settings',
  },
  {
    // Pacotes e políticas. O extrato de um tutor mora na ficha dele, que é onde o
    // balcão trabalha — aqui fica o que é do estabelecimento.
    key: 'financeiro',
    href: '/financeiro/pacotes',
    label: 'Financeiro',
    icon: <WalletIcon />,
    requires: 'finance:read',
  },
  {
    key: 'configuracoes',
    href: '/configuracoes',
    label: 'Configurações',
    icon: <SettingsIcon />,
    requires: 'tenant:read_settings',
  },
]

export interface AppShellProps {
  active: NavKey
  /** Resposta de `/me`: identidade, papel no tenant corrente e permissões. */
  me: MeResponse
  /**
   * Liga os blooms de fundo. Só o Início pede: nas telas de trabalho — listagem,
   * formulário — a atmosfera passaria a disputar atenção com o dado.
   */
  atmosphere?: boolean
  children: ReactNode
}

export function AppShell({ active, me, atmosphere = false, children }: AppShellProps) {
  // O menu não oferece o que a página recusaria: um link que sempre devolve o usuário
  // ao início é pior do que link nenhum.
  const items = NAV.filter(
    (item) => !item.requires || me.permissions.includes(item.requires),
  )

  const trialDaysLeft = trialDaysLeftOf(me.currentTenant?.trialEndsAt)
  const roleLabel = roleLabelOf(me)

  // `--color-focus` chega de `/v1/me` como a cor de marca do tenant corrente
  // (Configurações → Identidade visual). Sem tenant, `me.primaryColor` é `null` e o
  // campo herda o acento padrão que `globals.css` já define na raiz.
  const brandStyle = me.primaryColor
    ? ({ '--color-focus': me.primaryColor } as CSSProperties)
    : undefined

  return (
    <div className="flex min-h-[100svh] bg-surface" style={brandStyle}>
      <Sidebar active={active} items={items} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            {trialDaysLeft !== null && (
              <Badge tone="accent">
                {trialDaysLeft === 0
                  ? 'Último dia de teste'
                  : `${trialDaysLeft} ${trialDaysLeft === 1 ? 'dia' : 'dias'} de teste`}
              </Badge>
            )}
          </div>

          {/*
           * Identidade à direita: nome e papel no tenant, depois o avatar do Clerk
           * (que também é o menu da conta). O papel fica visível o tempo todo de
           * propósito — num sistema com quatro perfis de permissão, "por que não vejo
           * essa tela?" é a dúvida mais frequente, e a resposta está aqui.
           *
           * O texto alinhado à direita para encostar no avatar: alinhado à esquerda,
           * nome curto e papel longo deixariam um vão entre o bloco e o avatar.
           */}
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 text-right leading-tight">
              <p className="truncate text-sm font-medium">{me.user.fullName}</p>
              {roleLabel && <p className="hint truncate">{roleLabel}</p>}
            </div>
            <UserButton />
          </div>
        </header>

        {/* Navegação de bolso: abaixo de `lg` a lateral some e vira esta faixa. */}
        <nav className="flex gap-1 overflow-x-auto border-b border-line px-4 py-2 text-sm lg:hidden">
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === active ? 'page' : undefined}
              className={`btn btn-ghost shrink-0 px-3 py-1.5 ${
                item.key === active ? 'bg-card text-ink' : ''
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/*
         * `overflow-hidden` só com atmosfera: os blooms sangram para fora da caixa e,
         * sem o recorte, criariam rolagem horizontal na página.
         */}
        <main className={`relative flex-1 px-4 pb-16 pt-8 sm:px-8 ${atmosphere ? 'overflow-hidden' : ''}`}>
          {atmosphere && <Atmosphere />}
          {/* `z-10`: elemento posicionado pinta sobre bloco não posicionado — sem isso
              os blooms cobririam o texto. */}
          <div className="relative z-10">{children}</div>
        </main>
      </div>
    </div>
  )
}

/**
 * Menu lateral.
 *
 * `sticky` com altura de viewport: a lista acompanha a rolagem do conteúdo em vez de
 * subir junto com ele. Escondido abaixo de `lg`, onde 260px de largura fixa comeriam
 * metade da tela.
 */
function Sidebar({ active, items }: { active: NavKey; items: NavItem[] }) {
  return (
    <aside className="sticky top-0 hidden h-[100svh] w-[260px] shrink-0 flex-col border-r border-line px-4 py-5 lg:flex">
      <Link href="/dashboard" aria-label="Ir para o início" className="px-2 py-1">
        <Logo />
      </Link>

      <nav className="mt-8 flex flex-col gap-1 text-sm">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            aria-current={item.key === active ? 'page' : undefined}
            className={`nav-item ${item.key === active ? 'nav-item-active' : ''}`}
          >
            <span className="shrink-0">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  )
}

/** Papel do usuário no tenant corrente; `null` se ele ainda não tem vínculo ativo. */
function roleLabelOf(me: MeResponse): string | null {
  const tenantId = me.currentTenant?.id
  if (!tenantId) return null
  return me.memberships.find((m) => m.tenantId === tenantId)?.roleLabel ?? null
}

/** Dias inteiros até o fim do teste, nunca negativo. */
export function trialDaysLeftOf(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null
  const remaining = new Date(trialEndsAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)))
}
