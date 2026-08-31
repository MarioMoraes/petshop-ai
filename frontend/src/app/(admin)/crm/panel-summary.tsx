import {
  MESSAGE_BLOCK_REASON_LABELS,
  MESSAGE_QUEUE_STUCK_COUNT,
  MESSAGE_QUEUE_STUCK_SECONDS,
  type MessageBlockReason,
  type MessageStats,
} from '@petshop/shared-types'
import { Card } from '@/components/ui'

/**
 * O resumo do painel: a faixa de alerta, os números do período e o porquê dos
 * bloqueios.
 *
 * Em arquivo próprio porque é o cabeçalho que responde à pergunta antes da lista — a
 * página vira composição, e as três peças ficam montáveis fora dela.
 */

/**
 * A faixa da fila represada (AC-03 de MOD-CRM-11).
 *
 * Os dois números são os mesmos que `checkQueueHealth` usa para gritar no log —
 * importados, não redigitados. Um painel que avisasse com outro limiar mostraria a
 * faixa sumir sem nada ter melhorado.
 */
export function StuckQueueBanner({ stats }: { stats: MessageStats }) {
  const stuck =
    stats.queued >= MESSAGE_QUEUE_STUCK_COUNT &&
    (stats.oldestPendingSeconds ?? 0) >= MESSAGE_QUEUE_STUCK_SECONDS

  if (!stuck) return null

  return (
    <div className="card border-danger/40 bg-danger-soft/60 px-5 py-4">
      <p className="text-sm font-semibold text-danger">A fila não está andando</p>
      <p className="hint mt-1">
        {stats.queued} mensagens esperam para sair, e a mais antiga está parada há{' '}
        {formatDuration(stats.oldestPendingSeconds ?? 0)}. Nada foi perdido — elas saem
        assim que o motor voltar. Se isso persistir, avise quem cuida da infraestrutura.
      </p>
    </div>
  )
}

/**
 * Os números do período.
 *
 * Bloqueadas ficam ao lado de falhas, e não somadas a elas, porque pedem ações
 * opostas: uma se reenvia, a outra se corrige no cadastro.
 */
export function StatsRow({ stats }: { stats: MessageStats }) {
  const tiles: { label: string; value: number; tone?: 'danger' }[] = [
    { label: 'Enviadas', value: stats.sent },
    { label: 'Entregues', value: stats.delivered },
    { label: 'Na fila', value: stats.queued + stats.scheduled },
    { label: 'Falhas', value: stats.failed + stats.dead, ...(stats.dead > 0 ? { tone: 'danger' as const } : {}) },
    { label: 'Bloqueadas', value: stats.blocked, ...(stats.blocked > 0 ? { tone: 'danger' as const } : {}) },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <p className="hint">{tile.label}</p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              tile.tone === 'danger' ? 'text-danger' : ''
            }`}
          >
            {tile.value}
          </p>
        </Card>
      ))}
    </div>
  )
}

/** Por que as bloqueadas foram bloqueadas — é o que diz onde está o conserto. */
export function BlockedBreakdown({ blockedByReason }: { blockedByReason: Record<string, number> }) {
  const reasons = Object.entries(blockedByReason).filter(([, count]) => count > 0)
  if (reasons.length === 0) return null

  return (
    <Card>
      <p className="text-sm font-medium">Por que foram bloqueadas</p>
      <ul className="mt-3 space-y-2">
        {reasons.map(([reason, count]) => (
          <li key={reason} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted">
              {MESSAGE_BLOCK_REASON_LABELS[reason as MessageBlockReason] ?? reason}
            </span>
            <span className="font-medium tabular-nums">{count}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/**
 * O que o painel ainda **não** mostra.
 *
 * O AC-01 pede o estado da conexão do WhatsApp em destaque, e ele não existe: o canal
 * chega na fatia 2, com a Evolution API. Dizer isso custa uma linha e evita que o
 * petshop conclua que o WhatsApp está quebrado — mesma razão da lista de "em breve"
 * do Início. Some daqui quando MOD-CRM-01 entrar.
 */
export function ChannelNotice() {
  return (
    <p className="hint rounded-xl border border-dashed border-line px-4 py-3">
      Hoje só o e-mail sai daqui. O WhatsApp do estabelecimento — e o estado da conexão
      dele — entra na próxima fatia do módulo.
    </p>
  )
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hora' : 'horas'}`
  const minutes = Math.max(1, Math.floor(seconds / 60))
  return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`
}
