import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import {
  AGENT_HANDOFF_LABELS,
  DEFAULT_TIMEZONE,
  addDays,
  todayIn,
  zonedDayRange,
} from '@petshop/shared-types'
import { AlertTriangleIcon, SparkleIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { FunilDeEscritas, MotivosDeHandoff, NumerosDoPeriodo, SeletorDePeriodo } from './painel'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'

/**
 * O painel de qualidade do atendimento automático (MOD-AI-09).
 *
 * Uma tela para uma pergunta: **o agente está resolvendo, e a que custo?** Tudo o que
 * está aqui existe para qualificar essa resposta — o motivo dos handoffs diz onde ele
 * trava, o funil das propostas diz se o cliente confia no que ele oferece, e o custo diz
 * se a conta fecha.
 *
 * Fica em página própria, e não em cima da fila: a fila é trabalho de agora e tem gente
 * esperando do outro lado; isto é leitura de gestão, que se faz uma vez por semana. Pôr
 * as duas coisas na mesma tela faria a segunda empurrar a primeira para baixo da dobra.
 *
 * O período vai na **URL**, como o do painel de entregas — "o mês passado" é um link.
 */

export const dynamic = 'force-dynamic'

/** Trinta dias: o ciclo do teto de gasto, que é a outra pergunta desta tela. */
const DEFAULT_WINDOW_DAYS = 30

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function QualidadePage({ searchParams }: PageProps) {
  // O plano antes de qualquer chamada: a página renderiza em paralelo com o layout, e
  // pedir a API primeiro traria o 402 para dentro da tela (ver `plano-indisponivel.tsx`).
  const sessao = await carregarMe()
  if (!temRecurso(sessao, 'AI_QUALITY'))
    return <PlanoIndisponivel me={sessao} feature="AI_QUALITY" />

  const params = await searchParams

  const settings = await serverApi()
    .getSettings()
    .catch(() => null)
  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE

  const hoje = todayIn(timezone)
  const to = asDate(params.to) ?? hoje
  const from = asDate(params.from) ?? addDays(to, -(DEFAULT_WINDOW_DAYS - 1))

  /**
   * A janela vai ao serviço como instante, e não como data crua.
   *
   * `2026-09-01` em São Paulo começa às 03:00Z, e mandar a data sem fuso jogaria três
   * horas de conversas para o mês errado — o mesmo cuidado que o painel de entregas
   * toma, e a mesma razão de o teto de gasto virar no fuso do estabelecimento.
   */
  const stats = await serverApi()
    .getAgentStats({
      from: zonedDayRange(from, timezone).from.toISOString(),
      to: zonedDayRange(to, timezone).to.toISOString(),
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  const failed = stats instanceof ApiError

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/crm/atendimentos" className="hover:underline">
            ← Atendimentos
          </Link>
        }
        title="Qualidade do atendimento automático"
        subtitle={
          failed
            ? 'O serviço não respondeu'
            : `${stats.conversations} ${stats.conversations === 1 ? 'conversa encerrada' : 'conversas encerradas'} no período`
        }
      />

      <SeletorDePeriodo hoje={hoje} from={from} to={to} />

      {failed ? (
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="O serviço não respondeu"
          description="O painel está indisponível agora. Recarregue em instantes."
        />
      ) : stats.conversations === 0 ? (
        <EmptyState
          icon={<SparkleIcon />}
          tone="icon-brand"
          title="Nenhuma conversa encerrada neste período"
          description="O painel conta o que já terminou. Conversa em andamento ainda não tem desfecho, e contá-la como não resolvida diria que o agente falhou no que ainda está fazendo."
        />
      ) : (
        <>
          <NumerosDoPeriodo stats={stats} />
          <div className="grid gap-4 lg:grid-cols-2">
            <MotivosDeHandoff handoffs={stats.handoffs} labels={AGENT_HANDOFF_LABELS} />
            <FunilDeEscritas writes={stats.writes} />
          </div>
        </>
      )}
    </div>
  )
}

/** Data inválida é data nenhuma: cai no padrão, que é a janela dos trinta dias. */
function asDate(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}
