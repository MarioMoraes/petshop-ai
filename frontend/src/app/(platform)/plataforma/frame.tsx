import Link from 'next/link'
import type { ReactNode } from 'react'
import { UserButton } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import {
  AlertTriangleIcon,
  HeartPulseIcon,
  IdCardIcon,
  ShieldCheckIcon,
  StoreIcon,
  TrendingUpIcon,
  type IconTone,
} from '@/components/icons'
import { Badge, Logo } from '@/components/ui'
import { ContaPessoal } from './conta-pessoal'

/**
 * A moldura do console da plataforma.
 *
 * É irmã do `AppShell` do Admin e **não** uma variação dele: aquela moldura lê `/v1/me`,
 * filtra o menu pela matriz de permissões do tenant corrente e mostra o nome do
 * estabelecimento na marca. Nada disso existe aqui — a sessão da plataforma é a que não
 * traz Organization, e não há tenant a nomear. O que sobra em comum é a física (lateral
 * de 260px, faixa grudada no topo, `nav-item`), e essa mora no `globals.css`, que as duas
 * dividem.
 *
 * **Esta moldura não fala com a API.** Toda leitura da plataforma pode ser recusada com
 * 404, e um shell que dependesse de uma delas transformaria a recusa em erro de layout —
 * a página inteira em branco, em vez do cartão que explica. Quem lê é cada tela.
 *
 * O menu não tem gate por item: quem chega até aqui passou pelo mesmo `platform_admins`
 * que serve as nove rotas, e não há papéis dentro da equipe da plataforma.
 */

type NavKey = 'saude' | 'estabelecimentos' | 'metricas' | 'alertas' | 'trilha' | 'equipe'

interface NavItem {
  key: NavKey
  /** Literal por causa do `typedRoutes`: o Next confere a rota em tempo de compilação. */
  href:
    | '/plataforma'
    | '/plataforma/estabelecimentos'
    | '/plataforma/metricas'
    | '/plataforma/alertas'
    | '/plataforma/trilha'
    | '/plataforma/equipe'
  label: string
  icon: ReactNode
  tone: IconTone
}

const NAV: NavItem[] = [
  {
    // A saúde é a entrada porque é a pergunta de quem abre isto às oito da manhã: o que
    // quebrou desde ontem. O resto do console se visita por motivo; esta tela, por hábito.
    key: 'saude',
    href: '/plataforma',
    label: 'Saúde',
    icon: <HeartPulseIcon />,
    tone: 'icon-health',
  },
  {
    key: 'estabelecimentos',
    href: '/plataforma/estabelecimentos',
    label: 'Estabelecimentos',
    icon: <StoreIcon />,
    tone: 'icon-brand',
  },
  {
    key: 'metricas',
    href: '/plataforma/metricas',
    label: 'Métricas',
    icon: <TrendingUpIcon />,
    tone: 'icon-metric',
  },
  {
    key: 'alertas',
    href: '/plataforma/alertas',
    label: 'Alertas',
    icon: <AlertTriangleIcon />,
    tone: 'icon-pet',
  },
  {
    key: 'trilha',
    href: '/plataforma/trilha',
    label: 'Trilha',
    icon: <ShieldCheckIcon />,
    tone: 'icon-system',
  },
  {
    // Por último, e é o lugar certo: conceder o papel é o que menos se faz e o que mais
    // pesa. Ver quem já tem antes de conceder é metade da razão de a lista existir.
    key: 'equipe',
    href: '/plataforma/equipe',
    label: 'Equipe',
    icon: <IdCardIcon />,
    tone: 'icon-people',
  },
]

export function PlataformaShell({ active, children }: { active: NavKey; children: ReactNode }) {
  return (
    <div className="flex min-h-[100svh] bg-surface">
      <aside className="sticky top-0 hidden h-[100svh] w-[260px] shrink-0 flex-col border-r border-line px-4 py-5 lg:flex">
        <Link href="/plataforma" aria-label="Ir para a saúde" className="block min-w-0 px-2 py-1">
          <Logo />
        </Link>
        {/*
          O selo é o que separa esta tela do Admin num relance. As duas moldurais são
          quase iguais de propósito — mesma física, mesmo tipo —, e sem uma marca de
          contexto a única diferença visível seria a lista do menu.
        */}
        <div className="mt-3 px-2">
          <Badge tone="accent">Plataforma</Badge>
        </div>

        <nav className="mt-8 flex flex-col gap-1 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === active ? 'page' : undefined}
              className={`nav-item ${item.key === active ? 'nav-item-active' : ''}`}
            >
              <span className={`icon-tint shrink-0 ${item.tone}`}>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur sm:px-8">
          <p className="flex min-w-0 items-center gap-2 text-[21px] font-semibold leading-8">
            <span className="truncate">Console da plataforma</span>
          </p>

          <div className="flex min-w-0 items-center gap-3">
            <span className="avatar-ring">
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: { width: '38px', height: '38px' },
                    userButtonAvatarBox: { width: '38px', height: '38px' },
                  },
                }}
              />
            </span>
          </div>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-line px-4 py-2 text-sm lg:hidden">
          {NAV.map((item) => (
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

        <main className="relative flex-1 px-4 pb-16 pt-8 sm:px-8">{children}</main>
      </div>
    </div>
  )
}

/**
 * A porta fechada.
 *
 * **Duas situações caem no mesmo 404 do backend, e elas pedem coisas diferentes de quem
 * lê**: com Organization ativa o caminho é trocar de contexto; sem ela, o caminho é alguém
 * conceder o papel. A primeira versão desta tela mostrava um cartão único para as duas, e
 * o preço foi um botão que não fazia nada visível — quem já estava na conta pessoal
 * clicava, a página recarregava igual, e a tela parecia quebrada.
 *
 * O que o cartão diz a mais do que dizia é **sobre quem está lendo**, nunca sobre a lista:
 * ele não nomeia ninguém e não confirma que alguém é da equipe. A recusa da API continua
 * sendo 404 para todo mundo, que é onde a decisão do RN-01 vale.
 *
 * `orgId` sai do token da requisição — a mesma sessão que a chamada recusada usou —, e não
 * do SDK do browser, que pode estar um passo atrás.
 */
export async function SemAcesso() {
  const { orgId } = await auth()

  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="card p-6 text-center sm:p-8">
        <span className="icon-chip icon-chip-sm icon-system mx-auto">
          <ShieldCheckIcon />
        </span>
        <h1 className="mt-4 text-xl font-semibold">Área da equipe PetShop AI</h1>

        {orgId ? (
          <>
            <p className="hint mx-auto mt-2 max-w-sm">
              Você está com um estabelecimento aberto, e a sessão da plataforma é justamente
              a que não tem nenhum. Volte para a sua conta pessoal para entrar.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <ContaPessoal />
              <Link href="/dashboard" className="btn btn-ghost">
                Ir para o meu petshop
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="hint mx-auto mt-2 max-w-sm">
              Sua sessão já é a conta pessoal, e mesmo assim o console não abriu: esta conta
              não está na equipe da plataforma. Quem já está pode conceder o acesso pelo
              próprio console, em Equipe.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Link href="/dashboard" className="btn btn-ghost">
                Ir para o meu petshop
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A API respondeu e não deu certo.
 *
 * Separado de `<SemAcesso>` porque as duas situações pedem coisas diferentes de quem lê:
 * ali, trocar de contexto; aqui, olhar o log. Misturar as duas mandaria a equipe procurar
 * problema de permissão quando o que caiu foi o banco.
 */
export function Falha({ titulo, mensagem }: { titulo: string; mensagem: string }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <span className="icon-chip icon-chip-sm icon-pet">
        <AlertTriangleIcon />
      </span>
      <h3 className="mt-4 text-lg font-semibold">{titulo}</h3>
      <p className="hint mt-2 max-w-md">{mensagem}</p>
    </div>
  )
}
