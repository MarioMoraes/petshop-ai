import type { ReactNode } from 'react'
import { Atmosphere } from '@/components/atmosphere'
import { Logo } from '@/components/ui'
import {
  BellIcon,
  CalendarIcon,
  HeartPulseIcon,
  UsersIcon,
  VanIcon,
  WalletIcon,
} from '@/components/icons'

/**
 * Tela de entrada: o produto de um lado, o formulário do Clerk do outro.
 *
 * O hero é o de `design/design-modelo.html`, virado de centralizado para dividido —
 * mesma atmosfera de três blooms, mesma pílula de rótulo, mesmo serif como voz de
 * destaque, mesma cascata de entrada. O que mudou é o eixo: no modelo o texto ocupa o
 * centro porque não disputa com nada; aqui ele cede metade da tela para o formulário,
 * que é a razão de a pessoa ter chegado.
 *
 * **Por que contar o produto numa tela de login.** Quem já é cliente entra sem ler
 * nada — o formulário está à direita, no caminho do olho de quem vem de um link. A
 * metade esquerda é para os outros dois casos: o funcionário que recebeu convite e
 * nunca viu o sistema, e o dono que está avaliando. Para esses, uma caixa de e-mail
 * sozinha no meio de uma tela branca não diz o que há do outro lado.
 *
 * **A lista de recursos só menciona o que existe.** É a mesma regra do `roadmap.tsx`
 * do painel: prometer na porta de entrada o que o sistema ainda não faz é a forma mais
 * cara de perder confiança, porque a decepção chega no primeiro dia de uso.
 */

interface Recurso {
  icone: ReactNode
  /** Família de cor do tipo, de `globals.css` §Tom do ícone. */
  tom: string
  titulo: string
  descricao: string
}

/**
 * O que o sistema faz hoje, na ordem em que o dia do petshop acontece: o cliente e o
 * pet, o horário marcado, a busca em casa, o serviço, a conta e o aviso que sai depois.
 *
 * **A lista cresce quando o código cresce, e só então.** Táxi Dog e mensagens entraram
 * quando os serviços passaram a responder; o Portal do Tutor e o site público do
 * petshop **não estão aqui** — o roteamento por host já existe, as telas não. É a mesma
 * regra do `roadmap.tsx` do painel, invertida: lá um item sai da lista quando ganha
 * endpoint, aqui ele só entra depois disso.
 *
 * Seis itens e não mais: a coluna divide a tela com o formulário, e uma lista que
 * precisa de rolagem para terminar deixa de ser um resumo do produto e vira catálogo.
 */
const RECURSOS: Recurso[] = [
  {
    icone: <UsersIcon />,
    tom: 'icon-people',
    titulo: 'Tutores e pets',
    descricao: 'Ficha, álbum de fotos e o histórico de cada animal num lugar só.',
  },
  {
    icone: <CalendarIcon />,
    tom: 'icon-time',
    titulo: 'Agenda de banho e tosa',
    descricao: 'Por profissional, com recorrência, check-in e check-out no balcão.',
  },
  {
    icone: <VanIcon />,
    tom: 'icon-time',
    titulo: 'Táxi Dog',
    descricao: 'Busca e entrega com motorista e veículo, e a rota do dia no celular.',
  },
  {
    icone: <HeartPulseIcon />,
    tom: 'icon-health',
    titulo: 'Prontuário e atendimento',
    descricao: 'Alergia e alerta médico antes de começar; o serviço vira histórico.',
  },
  {
    icone: <WalletIcon />,
    tom: 'icon-money',
    titulo: 'Conta corrente',
    descricao: 'Débito no check-out, pacotes, pagamentos e recibo em PDF.',
  },
  {
    icone: <BellIcon />,
    tom: 'icon-metric',
    titulo: 'Avisos automáticos',
    descricao: 'Confirmação e lembrete do horário saem por e-mail sozinhos.',
  },
]

/**
 * Cada peça sobe na ordem em que se lê. Os valores são os do hero do modelo
 * (150 · 300 · 700 ms); sem o parágrafo entre título e recursos, a lista ocupa o
 * tempo dele, e o formulário fecha a sequência — ele é o destino, não a abertura.
 */
const ATRASO = {
  selo: '0ms',
  titulo: '150ms',
  recursos: '300ms',
  rodape: '700ms',
} as const

export function AuthSplit({
  chamada,
  children,
}: {
  /** Uma linha acima do formulário, dizendo o que este lado faz. */
  chamada: string
  /** `<SignIn />` ou `<SignUp />`. O cartão é o do próprio Clerk. */
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-[1400px] px-2 pt-2 sm:px-4 sm:pt-4">
      <div className="shell relative flex min-h-[100svh] flex-col overflow-hidden">
        <Atmosphere />

        {/*
          `items-center` em vez de esticar as colunas: as duas metades têm alturas
          naturais bem diferentes (a do Clerk cresce com o método de login habilitado),
          e esticá-las ancoraria o texto no topo enquanto o formulário flutua no meio.
          Centradas, as duas compartilham a mesma linha de eixo.
        */}
        <div className="relative z-10 flex flex-1 items-center px-6 py-14 sm:px-10 lg:px-16">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_minmax(0,26rem)] lg:gap-20">
            <ProdutoLado />
            <FormularioLado chamada={chamada}>{children}</FormularioLado>
            {/*
              Vem depois do formulário no DOM, e não antes, de propósito. Quem abre esta
              tela no celular quase sempre já é cliente e veio para entrar: colocar o
              texto de produto acima empurraria o campo de e-mail para fora da primeira
              tela e cobraria uma rolagem de todo mundo para servir a minoria que ainda
              está avaliando. Abaixo, ele fica no caminho de quem procura, e fora do
              caminho de quem não procura.
            */}
            <ProdutoCompacto />
          </div>
        </div>

        <Rodape />
      </div>
    </div>
  )
}

/** A metade que explica o produto. Some abaixo de `lg` — ver `FormularioLado`. */
function ProdutoLado() {
  return (
    <div className="hidden lg:block">
      <span
        className="rise pill inline-flex items-center gap-2 border border-white bg-white/70 px-4 py-2 text-xs font-semibold text-accent shadow-[0_6px_16px_-8px_rgb(35_36_39/0.25)] backdrop-blur"
        style={{ animationDelay: ATRASO.selo }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        Software Para Gestão de PetShops
      </span>

      <h1
        className="rise mt-7 text-5xl font-semibold leading-[1.04] text-ink-soft xl:text-6xl"
        style={{ animationDelay: ATRASO.titulo }}
      >
        Administre seu{' '}
        <span className="relative inline-block text-accent">
          {/*
            O calor sob a palavra de destaque.

            No hero do modelo esta peça é uma lasca sólida de gradiente que encosta no
            título e escapa para fora do bloco — funciona lá porque o título ocupa a
            largura inteira da página e sobra espaço à direita para ela transbordar.
            Nesta coluna, que é metade da tela, a mesma forma não transborda: ela para
            no meio do vazio e o olho a lê como um objeto solto, não como acento.

            Então o que sobrevive aqui é a intenção, não a forma: o mesmo gradiente,
            desfocado e por baixo do texto, virando luz em vez de peça. É a linguagem
            dos blooms da atmosfera aplicada a uma palavra só.
          */}
          <span
            className="absolute -inset-x-4 -inset-y-2 -z-10 rounded-full bg-gradient-to-br from-[#f05a3c] to-[#c93a24] opacity-25 blur-2xl"
            aria-hidden="true"
          />
          PetShop
        </span>
        <br />
        em um só lugar
      </h1>

      {/*
        Duas colunas só a partir de `xl`. Entre 1024 e 1279 a coluna da esquerda tem
        cerca de 460px: partida ao meio, cada descrição cai para cinco ou seis linhas e
        o navegador começa a hifenizar no meio de "check-out". Uma lista alta e legível
        é melhor do que uma grade que cabe.

        E, onde há duas colunas, o `max-w-lg` sai. Ele foi medido para quatro itens em
        duas linhas; com seis, prender a grade em 512px deixa 230px por coluna — menos
        de 180px de texto ao lado do chip — e cada descrição vira quatro linhas soltas.
        Sem o limite, a lista ocupa os ~650px que a coluna já tem e as descrições cabem
        em duas. Abaixo de `xl` o `max-w-lg` continua valendo: lá a lista é uma coluna
        só, e linha larga demais cansa mais que linha estreita.
      */}
      <ul
        className="rise mt-10 grid max-w-lg gap-5 xl:max-w-none xl:grid-cols-2 xl:gap-x-9 xl:gap-y-6"
        style={{ animationDelay: ATRASO.recursos }}
      >
        {RECURSOS.map((recurso) => (
          <li key={recurso.titulo} className="flex gap-3.5">
            <span className={`icon-chip shrink-0 ${recurso.tom}`}>{recurso.icone}</span>
            <span>
              <span className="block text-sm font-semibold">{recurso.titulo}</span>
              <span className="hint mt-1 block leading-relaxed">{recurso.descricao}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A mesma promessa, no espaço de um celular.
 *
 * Não é a coluna da esquerda encolhida: é uma edição dela. Cai o título grande, que
 * num celular ocuparia a tela inteira, e caem as duas colunas de recursos, que viram
 * uma lista. O que sobrevive é o que responde à única pergunta que importa aqui: o
 * que este sistema faz.
 */
function ProdutoCompacto() {
  return (
    <div className="lg:hidden">
      <div className="border-t border-line pt-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-subtle">
          O que o PetShop AI faz
        </p>

        <ul className="mt-7 grid gap-5 sm:grid-cols-2">
          {RECURSOS.map((recurso) => (
            <li key={recurso.titulo} className="flex gap-3.5">
              <span className={`icon-chip shrink-0 ${recurso.tom}`}>{recurso.icone}</span>
              <span>
                <span className="block text-sm font-semibold">{recurso.titulo}</span>
                <span className="hint mt-1 block leading-relaxed">{recurso.descricao}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * A metade do formulário.
 *
 * O cartão é o do próprio Clerk, não um `.card` nosso por fora. Embrulhar geraria dois
 * cartões concêntricos — duas bordas, duas sombras — e o olho lê isso como falha de
 * alinhamento. A ponte entre os dois sistemas visuais está no `<ClerkProvider>` do
 * layout raiz, que já passa raio, cor de texto e cor primária.
 */
function FormularioLado({ chamada, children }: { chamada: string; children: ReactNode }) {
  return (
    <div className="rise mx-auto w-full max-w-md" style={{ animationDelay: ATRASO.titulo }}>
      <div className="mb-7 flex flex-col items-center gap-3 lg:items-start">
        <Logo />
        <p className="hint text-center lg:text-left">{chamada}</p>
      </div>
      {/*
        `[&>div]:w-full` porque o Clerk envolve o formulário num `rootBox` que encolhe
        para o conteúdo: sem isto o cartão não acompanha a coluna e desalinha do texto
        ao lado em telas largas.
      */}
      <div className="flex justify-center [&>div]:w-full lg:justify-start">{children}</div>
    </div>
  )
}

/**
 * O rodapé fica no shell, e não dentro de uma das colunas, porque vale para as duas.
 *
 * São as três garantias que um dono de petshop pergunta antes de colocar a carteira de
 * clientes num sistema — e todas as três já são verdade no código, não promessa: RLS
 * por tenant, papéis com permissão, consentimento registrado.
 */
function Rodape() {
  return (
    <div className="relative z-10 px-6 pb-8 sm:px-10 lg:px-16">
      <div
        className="rise mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-line pt-6 text-xs text-subtle lg:justify-start"
        style={{ animationDelay: ATRASO.rodape }}
      >
        <span className="font-semibold uppercase tracking-widest">Em conformidade</span>
        <span>Dados isolados por estabelecimento</span>
        <span aria-hidden="true" className="hidden opacity-40 sm:inline">
          ·
        </span>
        <span>Acesso por papel</span>
        <span aria-hidden="true" className="hidden opacity-40 sm:inline">
          ·
        </span>
        <span>Consentimento LGPD registrado</span>
      </div>
    </div>
  )
}
