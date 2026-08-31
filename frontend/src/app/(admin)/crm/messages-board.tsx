'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  MESSAGE_CATEGORY_LABELS,
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_STATUS_LABELS,
  MessageCategorySchema,
  MessageChannelSchema,
  MessageStatusSchema,
  type MessageCategory,
  type MessageChannel,
  type MessageStatus,
  type PaginatedMessages,
} from '@petshop/shared-types'
import { Card } from '@/components/ui'
import { MessageList } from './message-list'

/**
 * Filtros e lista do painel.
 *
 * O estado vive na **URL**, não em `useState`: o filtro é a pergunta que o admin está
 * fazendo, e uma pergunta que não cabe num link não pode ser passada adiante. É o
 * mesmo motivo pelo qual a data da agenda mora na URL.
 */

export interface BoardFilters {
  from: string
  to: string
  status?: MessageStatus | undefined
  channel?: MessageChannel | undefined
  category?: MessageCategory | undefined
}

interface Props {
  page: PaginatedMessages
  filters: BoardFilters
  timezone: string
  canSend: boolean
}

export function MessagesBoard({ page, filters, canSend }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const totalPages = Math.max(1, Math.ceil(page.total / page.limit))
  const filtered =
    filters.status !== undefined ||
    filters.channel !== undefined ||
    filters.category !== undefined

  /**
   * Muda a URL, e o servidor recarrega. Trocar um filtro sempre volta à página 1 —
   * continuar na 7 depois de estreitar a busca mostraria um vazio que parece erro.
   */
  function apply(patch: Partial<BoardFilters> & { page?: number }) {
    const next = { ...filters, ...patch }
    const search = new URLSearchParams()
    search.set('from', next.from)
    search.set('to', next.to)
    if (next.status) search.set('status', next.status)
    if (next.channel) search.set('channel', next.channel)
    if (next.category) search.set('category', next.category)
    if (patch.page && patch.page > 1) search.set('page', String(patch.page))

    startTransition(() => router.push(`/crm?${search.toString()}`))
  }

  return (
    <div className="space-y-5">
      <Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="hint">De</span>
            <input
              type="date"
              className="field mt-1"
              value={filters.from}
              max={filters.to}
              onChange={(event) => apply({ from: event.target.value, page: 1 })}
            />
          </label>

          <label className="block">
            <span className="hint">Até</span>
            <input
              type="date"
              className="field mt-1"
              value={filters.to}
              min={filters.from}
              onChange={(event) => apply({ to: event.target.value, page: 1 })}
            />
          </label>

          <label className="block">
            <span className="hint">Situação</span>
            <select
              className="field mt-1"
              value={filters.status ?? ''}
              onChange={(event) =>
                apply({
                  status: (event.target.value || undefined) as MessageStatus | undefined,
                  page: 1,
                })
              }
            >
              <option value="">Todas</option>
              {MessageStatusSchema.options.map((status) => (
                <option key={status} value={status}>
                  {MESSAGE_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="hint">Canal</span>
            <select
              className="field mt-1"
              value={filters.channel ?? ''}
              onChange={(event) =>
                apply({
                  channel: (event.target.value || undefined) as MessageChannel | undefined,
                  page: 1,
                })
              }
            >
              <option value="">Todos</option>
              {MessageChannelSchema.options.map((channel) => (
                <option key={channel} value={channel}>
                  {MESSAGE_CHANNEL_LABELS[channel]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="hint">Tipo</span>
            <select
              className="field mt-1"
              value={filters.category ?? ''}
              onChange={(event) =>
                apply({
                  category: (event.target.value || undefined) as MessageCategory | undefined,
                  page: 1,
                })
              }
            >
              <option value="">Todos</option>
              {MessageCategorySchema.options.map((category) => (
                <option key={category} value={category}>
                  {MESSAGE_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <MessageList
        messages={page.data}
        canSend={canSend}
        showTutor
        empty={
          filtered
            ? {
                title: 'Nenhuma mensagem com esses filtros',
                description: 'Alargue o período ou tire a situação para ver o que existe.',
              }
            : {
                title: 'Nada saiu neste período',
                description:
                  'As mensagens automáticas nascem dos agendamentos. Assim que houver movimento na agenda, elas aparecem aqui.',
              }
        }
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending || page.page <= 1}
            onClick={() => apply({ page: page.page - 1 })}
          >
            Anterior
          </button>
          <p className="hint">
            Página {page.page} de {totalPages} · {page.total}{' '}
            {page.total === 1 ? 'mensagem' : 'mensagens'}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending || page.page >= totalPages}
            onClick={() => apply({ page: page.page + 1 })}
          >
            Próxima
          </button>
        </div>
      )}
    </div>
  )
}
