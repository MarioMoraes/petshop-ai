import type { ReactNode } from 'react'
import { CalendarIcon, HeartPulseIcon, UsersIcon, WalletIcon } from '@/components/icons'
import { Badge } from '@/components/ui'

/**
 * Indicadores que o Início ainda vai mostrar, transcritos dos PRDs de `docs/prd/`.
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
    module: 'MOD-AGENDA',
    title: 'Agenda e operação',
    prd: 'agenda_operacao_06.md',
    icon: <CalendarIcon />,
    permissions: ['schedule:read_all', 'schedule:read_own'],
    indicators: [
      {
        label: 'Agenda do dia',
        detail: 'Quantos atendimentos hoje, por profissional e em que estado — agendado, check-in feito, concluído.',
      },
      {
        label: 'Ocupação da agenda',
        detail: 'Horas agendadas ÷ horas de jornada disponível. É o número que diz se falta cliente ou falta profissional.',
      },
      {
        label: 'Faltas (no-show)',
        detail: 'Percentual de agendamentos não cumpridos na semana — insumo da régua de relacionamento.',
      },
      {
        label: 'Cancelamentos em cima da hora',
        detail: 'Os que caem dentro da janela de 24h da política, que são os que realmente furam a agenda.',
      },
      {
        label: 'Pontualidade e duração real',
        detail: 'Diferença entre a hora marcada e a chegada, e entre a duração estimada e a executada. Desvio persistente significa que a agenda está mentindo.',
      },
    ],
  },
  {
    module: 'MOD-LEDGER',
    title: 'Financeiro',
    prd: 'financeiro_tutor_05.md',
    icon: <WalletIcon />,
    permissions: ['finance:read'],
    indicators: [
      {
        label: 'Contas a receber',
        detail: 'Total em aberto e o vencido por faixa (0–30, 30–60, 60+ dias). É o indicador que o dono abre primeiro.',
      },
      {
        label: 'Recebido no período',
        detail: 'Por forma de pagamento — revela quanto do balcão ainda é dinheiro vivo.',
      },
      {
        label: 'Prazo médio de recebimento',
        detail: 'Quantos dias, em média, entre prestar o serviço e receber por ele.',
      },
      {
        label: 'Pacotes ativos',
        detail: 'Percentual de tutores com pacote vigente: a medida de recorrência do negócio.',
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
        label: 'Atendimentos concluídos',
        detail: 'Por tipo, profissional e período. Hoje o sistema guarda alergias e alertas, mas ainda não fecha atendimento.',
      },
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
        label: 'Tutores para reativar',
        detail: 'Quem não aparece há 90 dias. Depende do atendimento concluído para saber quando foi a última vez.',
      },
      {
        label: 'Tutores com saldo devedor',
        detail: 'A lista de cobrança do dia — nasce junto com o financeiro.',
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
