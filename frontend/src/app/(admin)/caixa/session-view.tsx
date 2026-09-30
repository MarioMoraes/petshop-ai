import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  CASH_METHOD_LABELS,
  formatBRL,
  type CashMovementResponse,
  type CashSessionDetail,
  type CashSessionSummary,
} from '@petshop/shared-types'
import { Badge, Card, CardHead } from '@/components/ui'
import {
  BanknoteIcon,
  CalendarIcon,
  ReceiptIcon,
  ScaleIcon,
  WalletIcon,
  type IconTone,
} from '@/components/icons'

/**
 * As peças de leitura do caixa do dia — do caixa aberto e de um fechamento antigo.
 *
 * Renderizam no servidor, e por isso as datas saem **no fuso do estabelecimento**, que
 * a página passa: o servidor roda em UTC, e o caixa aberto às 8h apareceria às 11h.
 */

export function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

function formatDayShort(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

/** O dinheiro na gaveta: contado se fechado, esperado se aberto. */
export function cashInDrawer(session: CashSessionSummary): number {
  const cash = session.byMethod.find((row) => row.method === 'CASH')
  return cash?.countedCents ?? cash?.expectedCents ?? 0
}

/** A faixa de três números: o que se procura ao abrir a tela. */
export function SessionNumbers({
  session,
  timeZone,
}: {
  session: CashSessionSummary
  timeZone: string
}) {
  const facts: {
    label: string
    value: string
    hint: string
    icon: ReactNode
    tone: IconTone
  }[] = [
    {
      label: session.status === 'OPEN' ? 'Dinheiro na gaveta' : 'Dinheiro contado',
      value: formatBRL(cashInDrawer(session)),
      hint: `Troco inicial de ${formatBRL(session.openingFloatCents)}`,
      icon: <BanknoteIcon />,
      tone: 'icon-money',
    },
    {
      label: 'Recebido no caixa',
      value: formatBRL(session.receivedCents),
      hint: 'Vendas avulsas e pagamentos, menos estornos',
      icon: <WalletIcon />,
      tone: 'icon-money',
    },
    session.status === 'OPEN'
      ? {
          label: 'Aberto às',
          value: formatTime(session.openedAt, timeZone),
          hint: session.openedByName ? `por ${session.openedByName}` : 'Caixa aberto',
          icon: <CalendarIcon />,
          tone: 'icon-time',
        }
      : {
          label: 'Diferença',
          value: differenceText(session.differenceCents ?? 0),
          hint: session.closedByName ? `Fechado por ${session.closedByName}` : 'Caixa fechado',
          icon: <ScaleIcon />,
          tone: 'icon-metric',
        },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {facts.map((fact) => (
        // Cada cartão desce do branco para o claro do seu assunto — dinheiro em verde,
        // o horário em azul, a conferência em verde-azulado —, com o chip do mesmo tom.
        // Nenhum grita sozinho: a fila inteira ganha cor, como o menu lateral.
        <Card key={fact.label} className={`card-tint ${fact.tone}`}>
          <span className={`icon-chip icon-chip-sm ${fact.tone}`}>{fact.icon}</span>
          <p className="mt-4 text-3xl font-semibold tabular-nums">{fact.value}</p>
          <p className="text-base font-semibold">{fact.label}</p>
          <p className="hint mt-2">{fact.hint}</p>
        </Card>
      ))}
    </div>
  )
}

/**
 * Uma linha por forma de pagamento. Aberto, só o esperado; fechado, o esperado, o
 * contado e a diferença de cada forma — "não conferido" quando ninguém contou.
 */
export function MethodCard({ session }: { session: CashSessionSummary }) {
  const closed = session.status === 'CLOSED'
  return (
    <Card>
      <CardHead icon={<WalletIcon />} tone="icon-money" title="Por forma de pagamento" />
      <ul className="mt-4 divide-y divide-line">
        {session.byMethod.map((row) => {
          const diff = row.countedCents === null ? null : row.countedCents - row.expectedCents
          return (
            <li key={row.method} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="text-sm">{CASH_METHOD_LABELS[row.method]}</span>
              <span className="flex items-baseline gap-3 text-sm">
                {closed && (
                  <span className="hint">
                    {row.countedCents === null
                      ? 'não conferido'
                      : diff === 0
                        ? 'conferido'
                        : differenceText(diff ?? 0)}
                  </span>
                )}
                <span className="font-medium tabular-nums">{formatBRL(row.expectedCents)}</span>
              </span>
            </li>
          )
        })}
      </ul>
      {closed && session.closingNotes && (
        <p className="hint mt-3">Justificativa: {session.closingNotes}</p>
      )}
    </Card>
  )
}

export function MovementsCard({
  movements,
  timeZone,
}: {
  movements: CashMovementResponse[]
  timeZone: string
}) {
  return (
    <Card>
      <CardHead icon={<ReceiptIcon />} tone="icon-money" title="Movimentos" />
      {movements.length === 0 ? (
        <p className="hint mt-4">Nada entrou nem saiu da gaveta ainda.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {movements.map((movement) => (
            <li key={movement.id} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm">{movement.description}</span>
                <span className="hint">
                  {formatTime(movement.occurredAt, timeZone)} ·{' '}
                  {CASH_METHOD_LABELS[movement.method]}
                  {movement.createdByName ? ` · ${movement.createdByName}` : ''}
                </span>
              </span>
              <span
                className={`shrink-0 text-sm font-medium tabular-nums ${
                  movement.amountCents < 0 ? 'text-danger' : ''
                }`}
              >
                {movement.amountCents < 0 ? '−' : '+'}
                {formatBRL(Math.abs(movement.amountCents))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** Os fechamentos anteriores, com a diferença de cada um à vista. */
export function HistoryCard({
  items,
  timeZone,
}: {
  items: CashSessionSummary[]
  timeZone: string
}) {
  const closed = items.filter((item) => item.status === 'CLOSED')
  return (
    <Card>
      <CardHead icon={<BanknoteIcon />} tone="icon-money" title="Fechamentos anteriores" />
      {closed.length === 0 ? (
        <p className="hint mt-4">O primeiro fechamento aparece aqui.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {closed.map((item) => (
            <li key={item.id}>
              <Link
                href={`/caixa/${item.id}`}
                className="flex items-baseline justify-between gap-3 py-2.5 hover:text-ink"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {formatDayShort(item.openedAt, timeZone)}
                  </span>
                  <span className="hint">
                    {formatTime(item.openedAt, timeZone)} às{' '}
                    {item.closedAt ? formatTime(item.closedAt, timeZone) : '—'}
                    {item.closedByName ? ` · ${item.closedByName}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {(item.differenceCents ?? 0) !== 0 && (
                    <Badge tone={(item.differenceCents ?? 0) < 0 ? 'danger' : 'accent'}>
                      {differenceText(item.differenceCents ?? 0)}
                    </Badge>
                  )}
                  <span className="text-sm font-medium tabular-nums">
                    {formatBRL(item.receivedCents)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function differenceText(cents: number): string {
  if (cents === 0) return 'Sem diferença'
  return cents > 0 ? `Sobra ${formatBRL(cents)}` : `Falta ${formatBRL(-cents)}`
}

export type { CashSessionDetail }
