import type { ReactNode } from 'react'
import { Atmosphere } from '@/components/atmosphere'
import { Logo } from '@/components/ui'
import {
  BellIcon,
  CalendarIcon,
  DocumentIcon,
  GlobeIcon,
  HeartPulseIcon,
  InstagramIcon,
  SmartphoneIcon,
  SparkleIcon,
  UsersIcon,
  VanIcon,
  WalletIcon,
  WhatsAppIcon,
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
 * **A lista de recursos só menciona o que existe.** É a mesma regra que tirou o "Em breve"
 * do painel: prometer na porta de entrada o que o sistema ainda não faz é a forma mais
 * cara de perder confiança, porque a decepção chega no primeiro dia de uso.
 */

interface Recurso {
  icone: ReactNode
  /** Família de cor do tipo, de `globals.css` §Tom do ícone. */
  tom: string
  titulo: string
}

/**
 * O que o sistema faz hoje, na ordem em que o dia do petshop acontece: o cliente e o
 * pet, o horário marcado, a busca em casa, o serviço, a conta, o que sai depois — e, no
 * fim, as três superfícies em que o cliente se serve sozinho e o papel que sai delas.
 *
 * **Os títulos vão em Title Case**, com as palavras pequenas em caixa baixa — "Agenda
 * de Banho e Tosa", e não "Agenda De Banho E Tosa". Preposição, artigo e conjunção
 * ficam minúsculos; sigla mantém a forma que tem ("IA", "PDFs").
 *
 * **Só o título, sem descrição.** A lista não está aqui para ensinar o produto: está
 * para responder, num relance, se ele cobre o que a pessoa veio procurar. Dez nomes
 * lidos de cima a baixo respondem isso mais rápido do que dez parágrafos, e o que a
 * descrição explicava é exatamente o que a primeira tela de uso mostra sozinha.
 *
 * **A lista cresce quando o código cresce, e só então.** Táxi Dog e mensagens entraram
 * quando os serviços passaram a responder. O Portal do Tutor, o site público e os
 * documentos em PDF ficaram de fora por um tempo justamente por essa regra — o
 * roteamento por host já existia, as telas não —, e entram agora pelo mesmo motivo, que
 * é terem passado a existir. O atendimento por IA é o mais novo: o agente responde no
 * WhatsApp, propõe horário e confirma na agenda. O Início segue a mesma regra: um
 * indicador só aparece lá depois de existir dado que o responda.
 *
 * **Dez itens e não mais.** O teto não é o número, é o que ele protege: a coluna divide
 * a tela com o formulário, e uma lista que precisa de rolagem para terminar deixa de ser
 * um resumo do produto e vira catálogo. Sem as descrições sobra folga, mas ela é para o
 * respiro da coluna, não para um item novo — o décimo primeiro obriga a fundir dois que
 * já estão aqui.
 */
const RECURSOS: Recurso[] = [
  {
    icone: <UsersIcon />,
    tom: 'icon-people',
    titulo: 'Tutores e Pets',
  },
  {
    icone: <CalendarIcon />,
    tom: 'icon-time',
    titulo: 'Agenda de Banho e Tosa',
  },
  {
    icone: <VanIcon />,
    tom: 'icon-time',
    titulo: 'Táxi Dog',
  },
  {
    icone: <HeartPulseIcon />,
    tom: 'icon-health',
    titulo: 'Prontuário e Atendimento',
  },
  {
    icone: <WalletIcon />,
    tom: 'icon-money',
    titulo: 'Conta Corrente',
  },
  {
    icone: <BellIcon />,
    tom: 'icon-metric',
    titulo: 'Mensagens e Campanhas',
  },
  {
    icone: <SparkleIcon />,
    tom: 'icon-brand',
    titulo: 'Atendimento por IA',
  },
  {
    icone: <SmartphoneIcon />,
    tom: 'icon-people',
    titulo: 'Portal do Tutor',
  },
  {
    /*
     * Globo e teal são os do item Site no menu lateral (`app-shell.tsx`), como
     * `SmartphoneIcon` acima é o da faixa do Portal no Início. Um recurso que aparece em
     * dois lugares com desenhos diferentes cobra do leitor o trabalho de descobrir que
     * é a mesma coisa.
     */
    icone: <GlobeIcon />,
    tom: 'icon-metric',
    titulo: 'Site do Petshop',
  },
  {
    icone: <DocumentIcon />,
    tom: 'icon-system',
    titulo: 'Documentos e PDFs',
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
  /*
   * Uma camada só, e não o cartão dentro da página.
   *
   * As telas internas usam `.shell`: um retângulo de `--color-surface` com raio, sombra e
   * um respiro de `--color-canvas` em volta — a moldura que diz "isto é o aplicativo".
   * Aqui não há aplicativo ainda, e a moldura só acrescentava uma borda contornando o
   * hero. Sem ela o fundo é a própria página, que é o que o hero do modelo faz.
   *
   * O que se mantém é o fundo: a mesma `--color-surface` de `.shell` pintada na camada
   * inteira, e a `<Atmosphere />` por cima. O `overflow-hidden` continua sendo o que
   * segura os blooms dentro da tela — sem ele os três estouram e criam rolagem
   * horizontal.
   */
  return (
    <div className="relative flex min-h-[100svh] flex-col overflow-hidden bg-surface">
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
        Gestão de Petshop
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
        <br />e deixe a IA atender
      </h1>

      {/*
        Duas colunas em toda largura, e não só de `xl` para cima. Enquanto cada item
        tinha uma descrição de duas linhas isto era impossível: a metade esquerda mede
        ~370px a 1024, e partida ao meio sobram ~170px por coluna — largura em que a
        descrição virava quatro linhas soltas e o navegador hifenizava no meio de
        "check-out". Um título cabe nela: os mais longos quebram em duas linhas, mas
        dentro da altura que o chip já ocupa, então a linha da grade não cresce.

        O ganho é de altura. A lista de dez itens passou de 807px para 320px, que é o
        que devolve a faixa de 1024 a 1279 para dentro da primeira tela — ela rolava
        desde que a lista tinha seis itens com descrição.

        O `max-w-lg` sai junto com a coluna única: ele limitava o comprimento da linha
        de texto corrido, e não há mais texto corrido para limitar.
      */}
      <ul
        className="rise mt-9 grid grid-cols-2 gap-x-8 gap-y-5"
        style={{ animationDelay: ATRASO.recursos }}
      >
        {RECURSOS.map((recurso) => (
          <li key={recurso.titulo} className="flex items-center gap-3.5">
            <span className={`icon-chip shrink-0 ${recurso.tom}`}>{recurso.icone}</span>
            <span className="text-sm font-semibold leading-snug">{recurso.titulo}</span>
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

        <ul className="mt-7 grid gap-4 sm:grid-cols-2 sm:gap-x-8">
          {RECURSOS.map((recurso) => (
            <li key={recurso.titulo} className="flex items-center gap-3.5">
              <span className={`icon-chip shrink-0 ${recurso.tom}`}>{recurso.icone}</span>
              <span className="text-sm font-semibold leading-snug">{recurso.titulo}</span>
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
 * Quem assina o produto e por onde falar com quem o fez. Estava aqui, antes, a lista de
 * garantias de conformidade — RLS por tenant, papéis, MFA, trilha, LGPD. Saiu porque
 * respondia a uma pergunta que ninguém faz nesta tela: quem chega por um convite quer
 * entrar, e quem está avaliando quer saber com quem está falando. A conformidade continua
 * sendo verdade no código e tem lugar próprio para ser contada — o rodapé da porta de
 * entrada não era esse lugar.
 *
 * **Assinatura à esquerda, contatos à direita, a partir de `lg`.** A empresa nasce sob
 * a coluna do produto, onde a leitura começa, e os contatos fecham a linha sob a coluna
 * do formulário — o único trecho da faixa de baixo que ficaria vazio. Abaixo de `lg` o
 * rodapé volta ao centro e as duas metades empilham, porque lá não há duas colunas para
 * dividir.
 *
 * Os dois contatos são links de aplicativo, não páginas: `instagram.com/<perfil>` e
 * `wa.me/<número>` abrem o app instalado no celular e caem no site quando não há app.
 * O número vai só com dígitos e com o 55 na frente — `wa.me` não aceita a máscara que a
 * pessoa lê na tela, e é por isso que o texto visível e o `href` são escritos separados.
 */

const EMPRESA = 'Offices Tecnologia'

const CONTATOS = [
  {
    rotulo: '@offices_aplicativos',
    href: 'https://instagram.com/offices_aplicativos',
    icone: <InstagramIcon />,
    descricao: 'Instagram da Offices Tecnologia',
  },
  {
    rotulo: '(35) 99252-7113',
    href: 'https://wa.me/5535992527113',
    icone: <WhatsAppIcon />,
    descricao: 'WhatsApp da Offices Tecnologia',
  },
]

function Rodape() {
  return (
    <div className="relative z-10 px-6 pb-8 sm:px-10 lg:px-16">
      <div
        className="rise mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 border-t border-line pt-6 text-xs text-subtle lg:justify-between"
        style={{ animationDelay: ATRASO.rodape }}
      >
        <span className="font-semibold uppercase tracking-widest">{EMPRESA}</span>

        {/*
          Os dois contatos andam num invólucro próprio porque o `justify-between` do pai
          distribui os filhos que encontra: soltos, seriam três blocos espalhados na
          largura inteira e o Instagram pararia no meio do vazio. Agrupados, o pai vê dois
          filhos — a assinatura e os contatos —, que é a divisão que se quer ver.
        */}
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {CONTATOS.map((contato) => (
            /*
             * O link envolve ícone e texto, e não só o ícone: num rodapé de 12px o glifo
             * sozinho é um alvo de 18px, abaixo do que um dedo acerta sem mirar. Com o
             * rótulo junto, o alvo passa de 100px sem mudar nada do que se vê.
             */
            <a
              key={contato.href}
              href={contato.href}
              target="_blank"
              rel="noreferrer"
              aria-label={contato.descricao}
              className="inline-flex items-center gap-2 transition-colors hover:text-ink"
            >
              {contato.icone}
              {contato.rotulo}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
