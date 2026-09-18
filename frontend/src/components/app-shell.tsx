import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { UserButton } from '@clerk/nextjs'
import {
  PLAN_CATALOG,
  minimumPlanFor,
  type MeResponse,
  type PermissionKey,
  type PlanFeature,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'
import { montarPendencias } from '@/lib/pendencias'
import { marcarAgendamentosVistos } from '@/lib/pendencias-actions'
import { carregarPendencias } from '@/lib/pendencias.server'
import { Atmosphere } from './atmosphere'
import { NotificationsBell } from './notifications-bell'
import {
  AlertTriangleIcon,
  BellIcon,
  GlobeIcon,
  CalendarIcon,
  IdCardIcon,
  HomeIcon,
  PawPrintIcon,
  ReceiptIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersIcon,
  VanIcon,
  WalletIcon,
  WaveIcon,
  type IconTone,
} from './icons'
import { ButtonLink, NavLink, NavPill } from './links'
import { temRecurso } from './plano-indisponivel'
import { RouteProgress } from './route-progress'
import { TenantSwitcher } from './tenant-switcher'
import { Alert, Badge, Logo } from './ui'

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
  /**
   * O recurso de plano de que a área depende. O item **continua no menu** quando o plano
   * não o inclui, com o nome do plano ao lado: some quem não tem permissão, porque não há
   * o que fazer; fica quem não tem o plano, porque há — e a tela explica o quê.
   */
  feature?: PlanFeature
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
    feature: 'TAXI',
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
    feature: 'SITE',
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
  const items = NAV.filter((item) => !item.requires || me.permissions.includes(item.requires)).map(
    (item) => ({
      ...item,
      tag:
        item.feature && !temRecurso(me, item.feature)
          ? PLAN_CATALOG[minimumPlanFor(item.feature)].name
          : undefined,
    }),
  )

  /*
   * As duas leituras da moldura, juntas.
   *
   * A moldura é servidor: as pendências chegam ao sino como props já resolvidas, e o
   * browser nunca fala com o gateway. Cada fonte falha para `null` por conta própria
   * (ver `lib/pendencias.ts`), então isto não tem como derrubar a tela.
   *
   * O fuso da saudação é o do estabelecimento, e não o do servidor: um petshop em Rio
   * Branco seria cumprimentado com "boa tarde" às 9h locais porque o Node roda em UTC.
   * Falha para `null` pela mesma regra do sino — a saudação cai no fuso padrão, e nenhuma
   * tela do Admin cai junto com as Configurações. Quem não tem `tenant:read_settings`
   * recebe 403 e passa por este mesmo caminho.
   */
  const [pendenciasBrutas, settings] = await Promise.all([
    carregarPendencias(me),
    serverApi()
      .getSettings()
      .catch(() => null),
  ])
  const pendencias = montarPendencias(pendenciasBrutas)
  const timezone = settings?.timezone ?? 'America/Sao_Paulo'

  // Só quem está em TRIAL conta dias de teste. `trialEndsAt` não é zerado quando o
  // estabelecimento assina — a data fica no cadastro como registro do que foi o
  // período —, então ler só a data faz um tenant já ACTIVE continuar anunciando
  // "2 dias de teste" até o prazo antigo vencer. Quem manda é o status.
  const trialDaysLeft =
    me.currentTenant?.status === 'TRIAL' ? trialDaysLeftOf(me.currentTenant.trialEndsAt) : null
  const roleLabel = roleLabelOf(me)

  // `--color-focus` chega de `/v1/me` como a cor de marca do tenant corrente
  // (Configurações → Identidade visual). Sem tenant, `me.primaryColor` é `null` e o
  // campo herda o acento padrão que `globals.css` já define na raiz.
  const brandStyle = me.primaryColor
    ? ({ '--color-focus': me.primaryColor } as CSSProperties)
    : undefined

  return (
    <div className="flex min-h-[100svh] bg-surface" style={brandStyle}>
      {/*
       * Dentro do `brandStyle`, e não fora: a barra se pinta com `--color-focus`, que é
       * onde a cor de marca do tenant chega. Montada aqui, ela vale para todas as telas
       * do Admin sem cada uma lembrar de pedi-la.
       */}
      <RouteProgress />

      <Sidebar active={active} items={items} tenantName={me.currentTenant?.name ?? null} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur sm:px-8">
          {/*
           * À esquerda, a saudação — em toda tela, não só no Início — e o que é da
           * conta: o prazo do teste e, para quem trabalha em mais de um estabelecimento,
           * o seletor. O nome do petshop saiu daqui — ele agora é a marca no topo da
           * lateral, e repeti-lo na faixa era dizer duas vezes a mesma coisa a dois
           * palmos de distância.
           */}
          <div className="flex min-w-0 items-center gap-3">
            <Saudacao name={me.user.fullName} timezone={timezone} asTitle={active === 'inicio'} />
            <TenantSwitcher
              memberships={me.memberships}
              currentSlug={me.currentTenant?.slug ?? null}
            />
            {trialDaysLeft !== null && (
              // O selo leva a assinar para quem pode; para os outros é só a contagem.
              <Link
                href={me.permissions.includes('tenant:configure') ? '/assinatura' : '/dashboard'}
                className="shrink-0"
              >
                <Badge tone="accent">
                  {trialDaysLeft === 0
                    ? 'Último dia de teste'
                    : `${trialDaysLeft} ${trialDaysLeft === 1 ? 'dia' : 'dias'} de teste`}
                </Badge>
              </Link>
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
             * O atalho para o console da plataforma, só para quem é da equipe PetShop AI
             * (`platformAdmin` vem de `/v1/me`).
             *
             * Fica na faixa, e não no menu lateral: o menu é a lista do que se faz
             * **dentro** deste estabelecimento, e o console é o lugar de onde se olha
             * todos. Um item entre Agenda e Financeiro sugeriria que é mais uma área
             * daqui.
             *
             * **Só o ícone, do tamanho do sino.** Com a palavra "Plataforma" ele lia como
             * a ação da faixa, ao lado de um nome e um avatar que não têm rótulo nenhum —
             * e quem o vê é sempre a mesma meia dúzia de pessoas, que não precisa ler o
             * destino duas vezes. O nome fica no `aria-label` e no `title`, porque tirar
             * a palavra da tela não é tirá-la de quem usa leitor de tela.
             *
             * As classes são as do gatilho do sino (`notifications-bell.tsx`), e não um
             * `<ButtonLink>`: os dois são o mesmo tipo de alvo — ícone redondo de 36px que
             * acende no hover —, e um botão com moldura ao lado do sino desequilibraria o
             * canto. Mexer no tamanho de um pede mexer no outro.
             *
             * Ele não tenta trocar o contexto do Clerk aqui: a sessão da plataforma é a
             * que **não** tem Organization, e quem oferece a troca é o cartão do outro
             * lado, que sabe distinguir "estabelecimento aberto" de "conta fora da
             * equipe".
             */}
            {me.platformAdmin && (
              <Link
                href="/plataforma"
                aria-label="Console da plataforma"
                title="Console da plataforma"
                className="hidden h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-ink sm:grid"
              >
                <ShieldCheckIcon />
              </Link>
            )}
            {/*
             * O sino antes do nome, e não depois do avatar: o avatar é o fim da linha
             * — dali sai o menu da conta, e nada deve aparecer à direita dele.
             */}
            {/*
              A ação desce como prop porque o sino é client e a moldura é servidor —
              é assim que o token do Clerk continua fora do browser. Sem `revalidate`
              junto: o painel está aberto na hora do clique, e remontar a moldura
              faria a linha sumir debaixo do cursor de quem ia clicar nela. Ela some
              na próxima navegação, que é quando o contador sempre se atualizou.
            */}
            <NotificationsBell pendencias={pendencias} aoVer={marcarAgendamentosVistos} />
            <div className="min-w-0 text-right leading-tight">
              <p className="truncate text-sm font-medium">{me.user.fullName}</p>
              {roleLabel && <p className="hint truncate">{roleLabel}</p>}
            </div>
            {/*
             * Avatar bem acima do padrão do Clerk (28px): a foto ocupa tudo que sobra
             * dentro do anel de `.avatar-ring`, que só reserva os 3px da borda. Mexer
             * neste tamanho sem mexer no padding de lá muda o diâmetro externo.
             *
             * `userButtonAvatarBox` além de `avatarBox`: os dois descritores caem no mesmo
             * elemento, e só o específico vence a regra interna do widget. A `<img>` de
             * dentro é 100% da caixa, então a foto cresce junto.
             */}
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

        {/* Navegação de bolso: abaixo de `lg` a lateral some e vira esta faixa. */}
        <nav className="flex gap-1 overflow-x-auto border-b border-line px-4 py-2 text-sm lg:hidden">
          {items.map((item) => (
            <NavPill
              key={item.key}
              href={item.href}
              label={item.label}
              active={item.key === active}
            />
          ))}
        </nav>

        {/*
         * `overflow-hidden` só com atmosfera: os blooms sangram para fora da caixa e,
         * sem o recorte, criariam rolagem horizontal na página.
         */}
        <main
          className={`relative flex-1 px-4 pb-16 pt-8 sm:px-8 ${atmosphere ? 'overflow-hidden' : ''}`}
        >
          {atmosphere && <Atmosphere />}
          <ContaAviso me={me} />
          <MfaAviso mfa={me.mfa} />
          {/* `z-10`: elemento posicionado pinta sobre bloco não posicionado — sem isso
              os blooms cobririam o texto. */}
          <div className="relative z-10">{children}</div>
        </main>
      </div>
    </div>
  )
}

/**
 * O aviso de segundo fator pendente (MOD-SEC-02 e 03).
 *
 * **Em toda tela, e não só nas Configurações.** A pessoa a quem isto se dirige é a que
 * mais navega, e um aviso que só aparece onde ela raramente vai chegaria depois do
 * bloqueio. Some sozinho no instante em que o token seguinte trouxer o segundo fator
 * ligado — não há botão de dispensar, de propósito: dispensável é como se aprende a
 * ignorar.
 *
 * Dentro da carência é `status`, que espera o leitor de tela terminar a frase; depois
 * dela é `alert`, que interrompe. A diferença é a mesma que o produto faz: antes do
 * prazo é um lembrete, depois é a razão pela qual nada salva.
 */
function MfaAviso({ mfa }: { mfa: MeResponse['mfa'] }) {
  if (!mfa.required || mfa.enabled) return null

  const bloqueado = mfa.graceEndsAt === null || new Date(mfa.graceEndsAt).getTime() <= Date.now()

  return (
    <div className="relative z-10 mb-6">
      <Alert
        tone={bloqueado ? 'danger' : 'accent'}
        icon={<ShieldCheckIcon />}
        title={
          bloqueado
            ? 'Ative a verificação em duas etapas para voltar a operar'
            : 'Ative a verificação em duas etapas'
        }
        role={bloqueado ? 'alert' : 'status'}
      >
        {bloqueado ? (
          <>
            Nada é salvo enquanto a conta do administrador não tiver segundo fator. A consulta
            continua liberada. Abra o menu da sua conta, no canto superior direito, e ative a
            verificação em duas etapas.
          </>
        ) : (
          <>
            O perfil de administrador passa a exigir segundo fator
            {mfa.graceEndsAt ? ` a partir de ${prazo(mfa.graceEndsAt)}` : ''}. Ative pelo menu da
            sua conta, no canto superior direito.
          </>
        )}
      </Alert>
    </div>
  )
}

/**
 * O estado da conta, quando ele muda o que a pessoa consegue fazer (camada comercial).
 *
 * **Em toda tela**, pela mesma razão do aviso de MFA: quem descobre que nada salva no meio
 * de um cadastro precisa saber o porquê ali, e não numa tela que talvez nunca abra. O
 * botão leva à assinatura; quem não é administrador lê a frase e não vê o botão, porque
 * a tela de assinatura recusaria.
 */
function ContaAviso({ me }: { me: MeResponse }) {
  const status = me.currentTenant?.status
  const podeAssinar = me.permissions.includes('tenant:configure')

  const aviso =
    status === 'TRIAL_EXPIRED'
      ? {
          tone: 'danger' as const,
          title: 'O período de teste terminou',
          body: 'Tudo o que foi registrado continua aqui para consulta, mas nada novo é salvo até assinar um plano. O site e o Portal estão fora do ar para os clientes.',
        }
      : status === 'SUSPENDED'
        ? {
            tone: 'danger' as const,
            title: 'Assinatura suspensa por falta de pagamento',
            body: 'A consulta continua liberada, mas nada novo é salvo até a mensalidade em aberto ser paga. O site e o Portal estão fora do ar para os clientes.',
          }
        : status === 'PAST_DUE'
          ? {
              tone: 'accent' as const,
              title: 'Mensalidade em atraso',
              body: 'O sistema continua funcionando normalmente por alguns dias. Depois disso, fica só para consulta até o pagamento.',
            }
          : null
  if (!aviso) return null

  return (
    <div className="relative z-10 mb-6">
      <Alert
        tone={aviso.tone}
        icon={<AlertTriangleIcon />}
        title={aviso.title}
        role={aviso.tone === 'danger' ? 'alert' : 'status'}
      >
        {aviso.body}
        {podeAssinar ? (
          <span className="mt-3 block">
            <ButtonLink href="/assinatura">
              {status === 'TRIAL_EXPIRED' ? 'Assinar agora' : 'Regularizar pagamento'}
            </ButtonLink>
          </span>
        ) : (
          ' Fale com o administrador do estabelecimento.'
        )}
      </Alert>
    </div>
  )
}

function prazo(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(new Date(iso))
}

/**
 * A saudação, no canto esquerdo da faixa.
 *
 * **Fixa em todo o Admin, e não só no Início.** Ela nasceu como título do painel, e o
 * usuário pediu que ficasse: uma faixa que cumprimenta pelo primeiro nome é o que separa
 * um sistema de trabalho de um formulário de repartição, e ela some justamente nas telas
 * onde a pessoa passa o dia.
 *
 * **`<h1>` só no Início.** As demais telas já têm o seu, desenhado pelo `PageHeader`, e
 * dois `<h1>` na mesma página deixam o leitor de tela sem saber onde ele está. No Início
 * não há `PageHeader` — a saudação **é** o título, e é ela que herda a marcação.
 *
 * `truncate` no texto e não no bloco: o recorte precisa cair na frase, senão o aceno é a
 * primeira coisa que a faixa estreita corta.
 */
function Saudacao({
  name,
  timezone,
  asTitle,
}: {
  name: string
  timezone: string
  /** Início: aqui a saudação é o título da página. */
  asTitle: boolean
}) {
  const Tag = asTitle ? 'h1' : 'p'

  return (
    <Tag className="flex min-w-0 items-center gap-2 text-[21px] leading-8 font-semibold">
      <span className="truncate">
        {greetingFor(timezone)}, {firstNameOf(name)}.
      </span>
      {/*
        O aceno é decoração, não informação: `aria-hidden` no traçado (herdado de `BASE`)
        mantém o leitor de tela lendo só a frase. A inclinação e os arcos de movimento do
        traçado são o que fazem a mão aberta ler como aceno em vez de "pare"; o acento é a
        única cor quente do sistema, e uma saudação é o lugar dela.

        21px: o mesmo corpo da frase ao lado, e não os 20 do resto do conjunto. O ícone
        acompanha o tamanho do texto — um aceno que não cresce junto encolhe sozinho toda
        vez que a saudação sobe.
      */}
      <span className="inline-flex shrink-0 rotate-12 text-accent">
        <WaveIcon size={21} />
      </span>
    </Tag>
  )
}

/**
 * Saudação pelo fuso do estabelecimento, não pelo do servidor.
 *
 * O petshop de Rio Branco abre às 8h locais; renderizar "boa tarde" porque o Node roda em
 * UTC seria errado de um jeito que o dono nota todo dia.
 */
function greetingFor(timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('pt-BR', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(new Date()),
  )

  if (hour < 12) return 'Bom dia'
  if (hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

/** Só o primeiro nome: é assim que se cumprimenta alguém no balcão. */
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName
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
  items: Array<NavItem & { tag?: string | undefined }>
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
          // O tom não muda com o estado: azul é Agenda em repouso, em hover, ativa e
          // carregando. O que muda é o desenho — ver `NavLink`.
          <NavLink
            key={item.key}
            href={item.href}
            label={item.label}
            icon={item.icon}
            tone={item.tone}
            active={item.key === active}
            tag={item.tag}
          />
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

/** Dias inteiros até o fim do teste, nunca negativo. Não decide se o selo aparece. */
export function trialDaysLeftOf(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null
  const remaining = new Date(trialEndsAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)))
}
