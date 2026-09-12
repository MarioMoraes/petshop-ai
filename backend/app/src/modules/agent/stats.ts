import { withTenant } from '@petshop/db'
import {
  AGENT_STATS_MAX_DAYS,
  AGENT_STATS_WINDOW_DAYS,
  AGENT_WRITE_TOOLS,
  type AgentHandoffCount,
  type AgentHandoffReason,
  type AgentStats,
  type AgentStatsQuery,
  type AgentWriteFunnel,
} from '@petshop/shared-types'

/**
 * O painel de qualidade (MOD-AI-09).
 *
 * A pergunta que ele responde é uma só, e é a que decide se o módulo fica: **o agente
 * está resolvendo, e a que custo?** Tudo o mais na tela existe para qualificar essa
 * resposta — o motivo dos handoffs diz onde ele trava, o funil das propostas diz se o
 * cliente confia no que ele oferece, e o custo diz se a conta fecha.
 *
 * **O desfecho é observável, e é isso que a métrica mede** (AC-02). Resolvida é a
 * conversa que terminou **sem** passar por gente — não a que o modelo achou que tinha
 * resolvido. A diferença importa porque a segunda é o próprio agente se avaliando, e um
 * modelo que se dá nota alta continua parecendo ótimo enquanto a fila enche.
 *
 * **A tentação que este arquivo não cede.** Handoff por número desconhecido, por mídia ou
 * por telefone ambíguo não é culpa do agente: a conversa nunca foi dele. Excluí-los da
 * conta faria a taxa subir e não faria o petshop ser mais bem atendido — e qualquer lista
 * de exceções é o agente corrigindo a própria prova. A taxa fica literal, e o recorte por
 * motivo, logo ao lado, mostra quanto dela é isso. Quem lê decide.
 *
 * **O denominador são as conversas encerradas no período**, e não todas as que existiram.
 * Conversa aberta não tem desfecho, e contá-la como não resolvida diria que o agente
 * falhou em algo que ele ainda está fazendo. O varredor de inatividade fecha as caladas
 * em duas horas, então a defasagem é dessa ordem.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface Window {
  from: Date
  to: Date
}

/**
 * A janela pedida, ou os últimos trinta dias.
 *
 * O teto de um ano não é sobre carga: uma média de dois anos esconde a melhora do mês
 * passado atrás do que o agente fazia quando foi ligado.
 */
function resolveWindow(query: AgentStatsQuery, now = new Date()): Window {
  const to = query.to ?? now
  const from = query.from ?? new Date(to.getTime() - AGENT_STATS_WINDOW_DAYS * DAY_MS)

  const earliest = new Date(to.getTime() - AGENT_STATS_MAX_DAYS * DAY_MS)
  return { from: from < earliest ? earliest : from, to }
}

export async function readStats(tenantId: string, query: AgentStatsQuery): Promise<AgentStats> {
  const window = resolveWindow(query)

  return withTenant(tenantId, async (tx) => {
    const [desfechos, turnos, propostas, resposta] = await Promise.all([
      /**
       * Uma linha por motivo, mais a linha de `handoff_reason` nulo — que é justamente
       * a das resolvidas. Um `groupBy` e não duas contagens: a soma das linhas **é** o
       * denominador, e dois `count` separados podem discordar se uma conversa fechar
       * entre eles.
       */
      tx.agentConversation.groupBy({
        by: ['handoffReason'],
        where: { closedAt: { gte: window.from, lt: window.to } },
        _count: { _all: true },
        _sum: { costMillicents: true },
      }),

      tx.agentTurn.aggregate({
        where: { role: 'AGENT', createdAt: { gte: window.from, lt: window.to } },
        _count: { _all: true },
        _sum: { costMillicents: true },
      }),

      tx.agentToolCall.groupBy({
        by: ['status'],
        where: {
          tool: { in: [...AGENT_WRITE_TOOLS] },
          createdAt: { gte: window.from, lt: window.to },
        },
        _count: { _all: true },
      }),

      averageResponseSeconds(tx, tenantId, window),
    ])

    const conversations = desfechos.reduce((total, linha) => total + linha._count._all, 0)
    const resolved = desfechos.find((linha) => linha.handoffReason === null)?._count._all ?? 0

    const handoffs: AgentHandoffCount[] = desfechos
      .filter((linha): linha is typeof linha & { handoffReason: AgentHandoffReason } =>
        Boolean(linha.handoffReason),
      )
      .map((linha) => ({ reason: linha.handoffReason, total: linha._count._all }))
      .sort((a, b) => b.total - a.total)

    /**
     * O custo médio sai das **conversas encerradas**, e não da soma dos turnos dividida
     * por elas: um turno de hoje numa conversa que só fecha amanhã pertence ao gasto de
     * hoje (é assim que o teto mensal conta) e ao desfecho de amanhã. Misturar as duas
     * bases produziria uma média que não bate com nenhuma das duas colunas.
     */
    const closedCostMillicents = desfechos.reduce(
      (total, linha) => total + (linha._sum.costMillicents ?? 0),
      0,
    )

    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      conversations,
      resolved,
      resolutionRate: conversations === 0 ? 0 : Math.round((resolved / conversations) * 1000) / 10,
      handoffs,
      avgResponseSeconds: resposta,
      turns: turnos._count._all,
      costMillicents: turnos._sum.costMillicents ?? 0,
      avgCostMillicents: conversations === 0 ? 0 : Math.round(closedCostMillicents / conversations),
      writes: funnel(propostas),
    }
  })
}

function funnel(rows: { status: string; _count: { _all: number } }[]): AgentWriteFunnel {
  const total = (status: string): number =>
    rows.find((row) => row.status === status)?._count._all ?? 0

  return {
    proposed: total('PROPOSED'),
    confirmed: total('CONFIRMED'),
    superseded: total('SUPERSEDED'),
    expired: total('EXPIRED'),
    failed: total('FAILED'),
  }
}

/**
 * Quanto o agente demora para responder.
 *
 * A conta é entre **turnos vizinhos da mesma conversa**: a mensagem do cliente e a
 * resposta que veio logo depois dela. Em SQL porque é o que `LAG` faz numa passada — em
 * TypeScript seria trazer todos os turnos do período para casar par a par na memória, e
 * o período padrão é de trinta dias.
 *
 * **Par que atravessa a borda da janela não conta.** A mensagem de 23:59 do dia anterior
 * respondida às 00:01 fica de fora, porque o `LAG` só enxerga o que o filtro deixou
 * entrar. É uma distorção de um par por janela, contra a alternativa de ler um dia a mais
 * para descartá-lo depois.
 *
 * O turno da recepção (`STAFF`) fica fora: ele mede o tempo de uma pessoa, que é outra
 * pergunta e tem outra resposta esperada.
 */
async function averageResponseSeconds(
  tx: { $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  tenantId: string,
  window: Window,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ segundos: number | null }[]>`
    WITH vizinhos AS (
      SELECT t.role,
             t.created_at,
             LAG(t.created_at) OVER (PARTITION BY t.conversation_id ORDER BY t.created_at) AS anterior,
             LAG(t.role)       OVER (PARTITION BY t.conversation_id ORDER BY t.created_at) AS papel_anterior
        FROM agent_turns t
       WHERE t.tenant_id = ${tenantId}::uuid
         AND t.created_at >= ${window.from}
         AND t.created_at <  ${window.to}
    )
    SELECT AVG(EXTRACT(EPOCH FROM (created_at - anterior))) AS segundos
      FROM vizinhos
     WHERE role = 'AGENT' AND papel_anterior = 'TUTOR'
  `

  const segundos = rows[0]?.segundos
  return segundos === null || segundos === undefined ? null : Math.round(Number(segundos))
}
