import type { ReactNode } from 'react'
import {
  HeartPulseIcon,
  SmartphoneIcon,
  UsersIcon,
  VanIcon,
  WalletIcon,
} from '@/components/icons'
import { Badge } from '@/components/ui'

/**
 * Indicadores que o Início ainda vai mostrar, transcritos dos PRDs de `docs/prd/`.
 *
 * **Esta lista encolhe.** Agenda do dia, ocupação, contas a receber e recebido no
 * período saíram daqui — hoje são cartões de verdade lá em cima. Um item que continua
 * nesta lista depois de existir transforma o painel em mentira, então tirar daqui é
 * parte de entregar o módulo.
 *
 * **E cresce**, quando um módulo entra trazendo indicador que o PRD nomeia e ninguém
 * responde: o Taxi Dog e o Portal chegaram depois desta lista e ficaram de fora dela
 * por um tempo, o que é o mesmo defeito ao contrário — o painel calado sobre metade do
 * que o produto já faz.
 *
 * Estão aqui, visíveis e desligados, em vez de esperarem os módulos ficarem prontos,
 * por duas razões. A primeira é para o dono do petshop: um painel que mostra três
 * números e nada mais parece um produto raso — mostrando o que vem, ele entende que
 * está vendo o começo de algo, não o todo. A segunda é para quem constrói: cada item
 * abaixo é a métrica de negócio que o PRD do módulo já especificou, então o painel
 * final não precisa ser inventado depois, só ligado.
 *
 * A regra para entrar nesta lista é ser um indicador que **o PRD nomeia** e que hoje
 * não tem endpoint que o responda. Nada de desejo solto: o que está aqui tem origem
 * rastreável, e o campo `prd` diz onde.
 *
 * Cada bloco é filtrado pela permissão que vai governar o painel de verdade quando ele
 * existir — as chaves já estão na matriz de `packages/shared-types/src/permissions.ts`.
 * Um banhista não precisa saber que um dia haverá contas a receber nesta tela.
 */

interface Indicator {
  label: string
  detail: string
}

interface PlannedBlock {
  module: string
  title: string
  /** Arquivo em `docs/prd/` de onde as métricas abaixo foram tiradas. */
  prd: string
  icon: ReactNode
  /** Basta uma das chaves para o bloco aparecer. */
  permissions: string[]
  indicators: Indicator[]
}

const PLANNED: PlannedBlock[] = [
  {
    module: 'MOD-LEDGER',
    title: 'Financeiro',
    prd: 'financeiro_tutor_05.md',
    icon: <WalletIcon />,
    permissions: ['finance:read'],
    indicators: [
      {
        label: 'Prazo médio de recebimento',
        detail: 'Quantos dias, em média, entre prestar o serviço e receber por ele.',
      },
      {
        label: 'Taxa de adesão a pacotes',
        detail: 'Percentual da carteira com pacote vigente. Os pacotes já existem e são vendidos; o que falta é a razão sobre a base.',
      },
      {
        label: 'Crédito expirado sem uso',
        detail: 'Valor de pacote que venceu sem ser consumido. É alerta de cliente frustrado, não receita.',
      },
      {
        label: 'Prejuízo das faltas',
        detail: 'Quanto o no-show custou e quanto foi efetivamente cobrado — a base para decidir ligar a multa.',
      },
    ],
  },
  {
    module: 'MOD-PRONT',
    title: 'Atendimentos e prontuário',
    prd: 'prontuario_04.md',
    icon: <HeartPulseIcon />,
    permissions: ['record:read', 'record:read_summary'],
    indicators: [
      {
        label: 'Vacinas atrasadas',
        detail: 'Pets com dose vencida — compliance e oportunidade de receita no mesmo número.',
      },
      {
        label: 'Pets com alerta crítico',
        detail: 'Alergia grave, temperamento de risco, necessidade de focinheira. Segurança de quem trabalha com o animal.',
      },
      {
        label: 'Bloqueios por alergia',
        detail: 'Quantas vezes o sistema barrou um serviço e quantas foi liberado assim mesmo. Override frequente é alerta mal cadastrado — ou risco assumido.',
      },
    ],
  },
  {
    module: 'MOD-TUTOR · MOD-CRM',
    title: 'Carteira e relacionamento',
    prd: 'tutores_02.md',
    icon: <UsersIcon />,
    permissions: ['tutor:read'],
    indicators: [
      {
        label: 'Cadastros completos',
        detail: 'Percentual em COMPLETE. É o que limita a qualidade de qualquer automação sobre a base.',
      },
      {
        label: 'Opt-in de WhatsApp',
        detail: 'Teto de alcance de qualquer campanha: sem consentimento não há mensagem.',
      },
      {
        label: 'Régua de cobrança',
        detail: 'Quem cobrar hoje e por qual canal. O saldo e a tag de inadimplente já existem; falta o MOD-CRM disparar.',
      },
    ],
  },
  {
    module: 'MOD-TAXI',
    title: 'Taxi Dog',
    prd: 'taxi_dog_07.md',
    icon: <VanIcon />,
    /*
     * `taxi:configure`, e não o `taxi:operate` que abre a tela do Taxi. Quem dirige a
     * van executa a corrida; a largura da janela e o tamanho da frota são decisão de
     * quem configura o módulo, e é a essa pessoa que estes três números servem.
     */
    permissions: ['taxi:configure'],
    indicators: [
      {
        label: 'Aderência à janela',
        detail: 'Quanto das corridas chegou dentro da janela prometida. O PRD chama de métrica principal do módulo, porque a janela é a promessa feita ao tutor — hoje ela só existe como linha de log, escrita por um job de varredura.',
      },
      {
        label: 'Falhas por motivo',
        detail: 'Sem espaço na van, endereço errado, ninguém em casa. Separar por motivo é o que distingue capacidade mal configurada de imprevisto da rua.',
      },
      {
        label: 'Duração da perna por zona',
        detail: 'Quanto tempo a van leva de verdade em cada zona. É o número que corrige a largura da janela padrão, que hoje é chute.',
      },
    ],
  },
  {
    module: 'MOD-PORTAL',
    title: 'Portal do tutor',
    prd: 'portal_tutor_09.md',
    icon: <SmartphoneIcon />,
    /*
     * `tenant:configure` é a permissão que liga e desliga o Portal. Adoção é a pergunta
     * de quem tomou essa decisão e quer saber se ela valeu — não é assunto de balcão,
     * onde o número só diria que o movimento veio por outro caminho.
     */
    permissions: ['tenant:configure'],
    indicators: [
      {
        label: 'Agendamentos pelo Portal',
        detail: 'Quantos o tutor marcou sozinho, contra os marcados no balcão. É o indicador que o PRD-mãe escolheu para medir a fase inteira.',
      },
      {
        label: 'Funil de vinculação',
        detail: 'Quantos pedem o código de acesso e quantos chegam ao fim. A distância entre os dois é o que diz se a porta de entrada está no lugar certo.',
      },
      {
        label: 'Bloqueios do self-service',
        detail: 'Pedido barrado por antecedência, crédito ou falta de vaga. Cada um é um tutor que tentou resolver sozinho e acabou ligando.',
      },
      {
        label: 'Tutores ativos no Portal',
        detail: 'Quem abriu o Portal nos últimos 30 dias. A data já é gravada a cada visita; falta somá-la — e é ela que diz para quem ainda vale gastar WhatsApp.',
      },
    ],
  },
]

/**
 * Painel do que ainda não existe.
 *
 * Tratamento deliberadamente mais leve que o dos números reais: borda tracejada, fundo
 * rebaixado, sem sombra. O olho precisa separar em um relance o que é dado do que é
 * promessa — se as duas seções tivessem o mesmo peso, o painel mentiria.
 *
 * Por isso os chips ficam de fora da cor por tipo e seguem em `--color-subtle`: é a
 * única exceção à regra de que a cor diz o tipo, e ela existe porque aqui o cinza está
 * dizendo outra coisa — "ainda não existe". Colorir estes chips daria aos módulos que
 * faltam o mesmo brilho dos que já respondem.
 */
export function Roadmap({ permissions }: { permissions: string[] }) {
  const blocks = PLANNED.filter((block) =>
    block.permissions.some((permission) => permissions.includes(permission)),
  )

  if (blocks.length === 0) return null

  return (
    <section className="mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">O que este painel ainda vai mostrar</h2>
        <p className="hint">Especificado nos PRDs, à espera dos módulos.</p>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {blocks.map((block) => (
          <div
            key={block.module}
            className="rounded-[24px] border border-dashed border-line bg-white/45 p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="icon-chip text-subtle">{block.icon}</span>
                <div>
                  <h3 className="font-semibold">{block.title}</h3>
                  <p className="hint">
                    {block.module} · {block.prd}
                  </p>
                </div>
              </div>
              <Badge>Em breve</Badge>
            </div>

            <ul className="mt-5 space-y-3">
              {block.indicators.map((indicator) => (
                <li key={indicator.label} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                  <p className="text-sm font-medium text-muted">{indicator.label}</p>
                  <p className="hint mt-0.5 leading-relaxed">{indicator.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
