import Link from 'next/link'
import {
  addDays,
  formatAgentCost,
  type AgentHandoffCount,
  type AgentHandoffReason,
  type AgentStats,
  type AgentWriteFunnel,
} from '@petshop/shared-types'
import { Card } from '@/components/ui'

/**
 * As peças do painel de qualidade (MOD-AI-09).
 *
 * Cartão branco, e não `tone="soft"`: isto é conteúdo — números e listas —, e a ficha
 * com campos é a outra coisa (`docs/design-formularios.md`, regra 1). O molde dos
 * ladrilhos é o do painel de entregas do MOD-CRM, e é o mesmo de propósito: duas telas
 * que respondem "como foi o período" não devem ter duas gramáticas.
 *
 * **Nada aqui é gráfico.** Cinco números e duas listas curtas cabem em texto, e texto se
 * lê no celular, imprime, e não precisa de legenda para dizer qual barra é qual.
 */

/** Os atalhos de período. Links, e não estado de cliente: o período é endereço. */
export function SeletorDePeriodo({
  hoje,
  from,
  to,
}: {
  hoje: string
  from: string
  to: string
}) {
  const opcoes = [
    { dias: 7, label: '7 dias' },
    { dias: 30, label: '30 dias' },
    { dias: 90, label: '90 dias' },
  ]

  const janela = diasEntre(from, to)
  const atual = to === hoje ? janela : null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {opcoes.map((opcao) => {
        const ativo = atual === opcao.dias
        return (
          <Link
            key={opcao.dias}
            href={`/crm/atendimentos/qualidade?from=${addDays(hoje, -(opcao.dias - 1))}&to=${hoje}`}
            aria-current={ativo ? 'page' : undefined}
            className={`pill px-4 py-1.5 text-sm ${
              ativo ? 'bg-accent-soft font-medium text-accent-ink' : 'bg-black/5 text-muted'
            }`}
          >
            {opcao.label}
          </Link>
        )
      })}
      <span className="hint ml-1">
        {formatarData(from)} a {formatarData(to)}
      </span>
    </div>
  )
}

/**
 * Os cinco números do período.
 *
 * A taxa de resolução vem junto do número absoluto porque sozinha ela mente nas pontas:
 * 100% de duas conversas não é um agente que funciona, e a lista ao lado é que diz o
 * resto da história.
 */
export function NumerosDoPeriodo({ stats }: { stats: AgentStats }) {
  const ladrilhos = [
    { label: 'Conversas encerradas', valor: String(stats.conversations) },
    {
      label: 'Resolvidas sem a equipe',
      valor: `${stats.resolutionRate.toLocaleString('pt-BR')}%`,
      nota: `${stats.resolved} de ${stats.conversations}`,
    },
    {
      label: 'Tempo médio de resposta',
      valor: stats.avgResponseSeconds === null ? '—' : formatarSegundos(stats.avgResponseSeconds),
      nota: stats.avgResponseSeconds === null ? 'o agente não respondeu nada' : undefined,
    },
    {
      label: 'Custo no período',
      valor: formatAgentCost(stats.costMillicents),
      nota: `${stats.turns} ${stats.turns === 1 ? 'turno' : 'turnos'} do modelo`,
    },
    {
      label: 'Custo por conversa',
      valor: formatAgentCost(stats.avgCostMillicents),
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {ladrilhos.map((ladrilho) => (
        <Card key={ladrilho.label}>
          <p className="hint">{ladrilho.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{ladrilho.valor}</p>
          {ladrilho.nota && <p className="hint mt-1 text-xs">{ladrilho.nota}</p>}
        </Card>
      ))}
    </div>
  )
}

/**
 * Por que as conversas passaram para a equipe.
 *
 * **É o que qualifica a taxa ao lado.** Número sem cadastro, áudio e telefone em duas
 * fichas nunca foram do agente: a conversa chegou e foi direto para a fila. Eles entram
 * na conta da taxa porque o desfecho é observável e nenhuma exceção seria honesta — e
 * aparecem aqui para quem lê saber quanto da taxa é isso.
 */
export function MotivosDeHandoff({
  handoffs,
  labels,
}: {
  handoffs: AgentHandoffCount[]
  labels: Record<AgentHandoffReason, string>
}) {
  const total = handoffs.reduce((soma, linha) => soma + linha.total, 0)

  return (
    <Card>
      <p className="text-sm font-medium">Por que passaram para a equipe</p>

      {handoffs.length === 0 ? (
        <p className="hint mt-3">
          Nenhuma. Todas as conversas encerradas no período terminaram com o agente.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {handoffs.map((linha) => (
            <li key={linha.reason} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted">{labels[linha.reason]}</span>
              <span className="whitespace-nowrap font-medium tabular-nums">
                {linha.total}
                <span className="hint ml-2 text-xs">
                  {Math.round((linha.total / total) * 100)}%
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/**
 * O funil das escritas (MOD-AI-04).
 *
 * **A linha que importa é a de confirmadas sobre propostas.** Ela responde a pergunta que
 * nenhuma outra métrica responde: o cliente aceita o que o agente oferece? Uma taxa baixa
 * com muitas superadas quer dizer que ele propõe antes de entender o pedido; com muitas
 * vencidas, que o cliente some no meio — e as duas pedem conserto em lugares diferentes.
 *
 * Não está no §3 do PRD, que foi escrito antes de a escrita existir. Está aqui porque é a
 * primeira coisa que se pergunta depois de ligar o agente para marcar horário.
 */
export function FunilDeEscritas({ writes }: { writes: AgentWriteFunnel }) {
  const total =
    writes.proposed + writes.confirmed + writes.superseded + writes.expired + writes.failed

  const linhas = [
    { label: 'Confirmadas pelo cliente', valor: writes.confirmed },
    { label: 'O cliente pediu outra coisa', valor: writes.superseded },
    { label: 'Venceram sem resposta', valor: writes.expired },
    { label: 'Não puderam ser gravadas', valor: writes.failed },
    { label: 'Ainda esperando resposta', valor: writes.proposed },
  ].filter((linha) => linha.valor > 0)

  return (
    <Card>
      <p className="text-sm font-medium">O que o agente propôs marcar</p>

      {total === 0 ? (
        <p className="hint mt-3">
          Nenhuma proposta no período. O agente marca, cancela e remarca em duas etapas, e
          só grava depois que o cliente confirma.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">
            <span className="font-semibold tabular-nums text-ink">{writes.confirmed}</span> de{' '}
            <span className="tabular-nums">{total}</span> propostas viraram agendamento
          </p>
          <ul className="mt-3 space-y-2">
            {linhas.map((linha) => (
              <li key={linha.label} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted">{linha.label}</span>
                <span className="font-medium tabular-nums">{linha.valor}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

/** "3 min", "48 s", "1 h 12 min" — a unidade que o número pede. */
function formatarSegundos(segundos: number): string {
  if (segundos < 90) return `${segundos} s`
  const minutos = Math.round(segundos / 60)
  if (minutos < 90) return `${minutos} min`
  const horas = Math.floor(minutos / 60)
  return `${horas} h ${minutos % 60} min`
}

function formatarData(isoDate: string): string {
  const [ano, mes, dia] = isoDate.split('-')
  return `${dia}/${mes}/${ano}`
}

/** Quantos dias a janela cobre, contando as duas pontas. */
function diasEntre(from: string, to: string): number {
  const inicio = new Date(`${from}T00:00:00Z`).getTime()
  const fim = new Date(`${to}T00:00:00Z`).getTime()
  return Math.round((fim - inicio) / 86_400_000) + 1
}
