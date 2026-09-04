import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { UserButton } from '@clerk/nextjs'
import type { MeResponse, PermissionKey } from '@petshop/shared-types'
import { montarPendencias } from '@/lib/pendencias'
import { carregarPendencias } from '@/lib/pendencias.server'
import { Atmosphere } from './atmosphere'
import { NotificationsBell } from './notifications-bell'
import {
  BellIcon,
  GlobeIcon,
  CalendarIcon,
  IdCardIcon,
  HomeIcon,
  PawPrintIcon,
  ReceiptIcon,
  SettingsIcon,
  UsersIcon,
  VanIcon,
  WalletIcon,
  type IconTone,
} from './icons'
import { TenantSwitcher } from './tenant-switcher'
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

type NavKey =
  | 'inicio'
  | 'tutores'
  | 'pets'
  | 'agenda'
  | 'taxi'
  | 'mensagens'
  | 'site'
  | 'financeiro'
  | 'cobranca'
  | 'equipe'
  | 'configuracoes'

interface NavItem {
  key: NavKey
  href:
    | '/dashboard'
    | '/tutores'
    | '/pets'
    | '/agenda/dia'
    | '/taxi'
    | '/crm'
    | '/site'
    | '/financeiro/pacotes'
    | '/cobranca'
    | '/equipe'
    | '/configuracoes'
  label: string
  icon: ReactNode
  /**
   * Família de cor do ícone. Anda junto com `icon` porque é o ícone que tem tom, não o
   * item de menu — o calendário é azul aqui e em qualquer outro lugar que o use.
   */
  tone: IconTone
  /**
   * Permissão que o item exige. Cada módulo declara a sua, em vez de todos
   * dependerem de `tenant:read_settings` — o financeiro é a primeira área que a
   * recepção acessa sem ser configuração, e um gate único já não descreveria a
   * matriz do RBAC.
   */
  requires?: PermissionKey
}

const NAV: NavItem[] = [
  { key: 'inicio', href: '/dashboard', label: 'Início', icon: <HomeIcon />, tone: 'icon-brand' },
  { key: 'tutores', href: '/tutores', label: 'Tutores', icon: <UsersIcon />, tone: 'icon-people' },
  { key: 'pets', href: '/pets', label: 'Pets', icon: <PawPrintIcon />, tone: 'icon-pet' },
  {
    // Fecha o bloco de cadastro — tutores, pets, equipe: as três listas de **quem** o
    // sistema conhece, antes de o menu passar ao que se faz com eles. E fora de
    // Configurações porque é gente, não ajuste: quem abre este menu pensando em
    // "adicionar a Ana" não procuraria dentro de um item chamado Configurações.
    key: 'equipe',
    href: '/equipe',
    label: 'Equipe',
    icon: <IdCardIcon />,
    tone: 'icon-people',
    requires: 'team:read',
  },
  {
    // A visão do dia é o destino: é a tela que a recepção abre de manhã e mantém
    // aberta. Serviços e profissionais são configuração, visitada de vez em quando.
    key: 'agenda',
    href: '/agenda/dia',
    label: 'Agenda',
    icon: <CalendarIcon />,
    tone: 'icon-time',
    requires: 'tenant:read_settings',
  },
  {
    // Logo depois da Agenda porque é dela que a corrida nasce: quem acabou de marcar
    // o banho é quem pergunta "e o leva-e-traz?".
    //
    // O gate é `taxi:operate`, que a recepção, o admin e o motorista têm. Quem não
    // faz leva-e-traz ainda vê o item — a permissão existe, o módulo é que está
    // desligado (RN-22) — e a própria tela explica como ligar. É melhor que esconder
    // um recurso que o cliente comprou e não encontra.
    key: 'taxi',
    href: '/taxi',
    label: 'Taxi Dog',
    icon: <VanIcon />,
    tone: 'icon-time',
    requires: 'taxi:operate',
  },
  {
    // Pacotes e políticas. O extrato de um tutor mora na ficha dele, que é onde o
    // balcão trabalha — aqui fica o que é do estabelecimento.
    key: 'financeiro',
    href: '/financeiro/pacotes',
    label: 'Financeiro',
    icon: <WalletIcon />,
    tone: 'icon-money',
    requires: 'finance:read',
  },
  {
    // Logo abaixo do Financeiro, e não dentro dele, porque a pergunta é outra: lá se
    // configura o estabelecimento — pacotes, políticas —, aqui se olha o dinheiro que
    // falta entrar e o que já entrou. Quem abre isto não vem ajustar nada; vem
    // imprimir uma folha e pegar o telefone.
    //
    // O gate é `finance:configure`, o mesmo das rotas `/v1/ledger/reports/*`: os dois
    // relatórios são leitura de gestão — um deles lista nome e telefone de todo mundo
    // que está devendo —, e não material de balcão.
    key: 'cobranca',
    href: '/cobranca',
    label: 'Cobrança',
    icon: <ReceiptIcon />,
    tone: 'icon-money',
    requires: 'finance:configure',
  },
  {
    // Mensagens e Site fecham o menu, logo antes de Configurações: são o que o petshop
    // mostra para fora — o que sai para o tutor e a página por onde quem ainda não é
    // cliente chega. O miolo da lista é o trabalho do dia (agenda, atendimento,
    // dinheiro); estes dois são visitados quando alguém para para olhar o
    // relacionamento, não no meio de um balcão cheio.
    //
    // O gate é `crm:read`, que a recepção também tem — ela precisa saber se o lembrete
    // chegou antes de pegar o telefone, e é essa pergunta que traz alguém a esta tela.
    key: 'mensagens',
    href: '/crm',
    label: 'Mensagens',
    icon: <BellIcon />,
    tone: 'icon-brand',
    requires: 'crm:read',
  },
  {
    // Logo abaixo de Mensagens porque é a outra ponta do mesmo relacionamento: ali se
    // vê o que saiu para quem já é cliente, aqui o contato que chegou de quem ainda
    // não é.
    //
    // O gate é `site:read_leads`, e não `site:manage`: a recepção trabalha o contato
    // que chegou pelo formulário sem poder publicar ou tirar a página do ar. A tela
    // se abre no que cada papel pode fazer.
    key: 'site',
    href: '/site',
    label: 'Site',
    icon: <GlobeIcon />,
    tone: 'icon-metric',
    requires: 'site:read_leads',
  },
  {
    key: 'configuracoes',
    href: '/configuracoes',
    label: 'Configurações',
    icon: <SettingsIcon />,
    tone: 'icon-system',
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

export async function AppShell({ active, me, atmosphere = false, children }: AppShellProps) {
  // O menu não oferece o que a página recusaria: um link que sempre devolve o usuário
  // ao início é pior do que link nenhum.
  const items = NAV.filter(
    (item) => !item.requires || me.permissions.includes(item.requires),
  )

  // A moldura é servidor: as pendências chegam ao sino como props já resolvidas, e o
  // browser nunca fala com o gateway. Cada fonte falha para `null` por conta própria
  // (ver `lib/pendencias.ts`), então isto não tem como derrubar a tela.
  const pendencias = montarPendencias(await carregarPendencias(me))

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
      <Sidebar active={active} items={items} tenantName={me.currentTenant?.name ?? null} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur sm:px-8">
          {/*
           * À esquerda, o que é da conta: o prazo do teste e, para quem trabalha em
           * mais de um estabelecimento, o seletor. O nome do petshop saiu daqui — ele
           * agora é a marca no topo da lateral, e repeti-lo na faixa era dizer duas
           * vezes a mesma coisa a dois palmos de distância.
           */}
          <div className="flex min-w-0 items-center gap-3">
            <TenantSwitcher
              memberships={me.memberships}
              currentSlug={me.currentTenant?.slug ?? null}
            />
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
            {/*
             * O sino antes do nome, e não depois do avatar: o avatar é o fim da linha
             * — dali sai o menu da conta, e nada deve aparecer à direita dele.
             */}
            <NotificationsBell pendencias={pendencias} />
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
function Sidebar({
  active,
  items,
  tenantName,
}: {
  active: NavKey
  items: NavItem[]
  /** Nome do estabelecimento aberto; `null` enquanto não há tenant resolvido. */
  tenantName: string | null
}) {
  return (
    <aside className="sticky top-0 hidden h-[100svh] w-[260px] shrink-0 flex-col border-r border-line px-4 py-5 lg:flex">
      <Link href="/dashboard" aria-label="Ir para o início" className="block min-w-0 px-2 py-1">
        <Logo name={tenantName} />
      </Link>

      <nav className="mt-8 flex flex-col gap-1 text-sm">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            aria-current={item.key === active ? 'page' : undefined}
            className={`nav-item ${item.key === active ? 'nav-item-active' : ''}`}
          >
            {/* O tom não muda com o estado: azul é Agenda em repouso, em hover e ativa. */}
            <span className={`icon-tint shrink-0 ${item.tone}`}>{item.icon}</span>
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
