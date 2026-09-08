import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import {
  DEFAULT_TIMEZONE,
  MessageCategorySchema,
  MessageRecipientKindSchema,
  MessageChannelSchema,
  MessageStatusSchema,
  addDays,
  todayIn,
  zonedDayRange,
} from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { MessagesBoard, type BoardFilters } from './messages-board'
import { BlockedBreakdown, ChannelNotice, StatsRow, StuckQueueBanner } from './panel-summary'

/**
 * Painel de entregas e falhas (MOD-CRM-11).
 *
 * O que o motor fez com o que lhe pediram: o que saiu, o que ainda espera, o que
 * falhou e o que foi **bloqueado** — e este último é a razão de a tela existir. Falha
 * de provedor se resolve reenviando; bloqueio, não: ele diz que a mensagem nunca
 * deveria sair, e o conserto está no cadastro do tutor ou na lista de supressão. Um
 * painel que somasse os dois num "não entregue" mandaria o admin reenviar para sempre.
 *
 * Os filtros e a página vão na **URL**, como a data da agenda: o admin manda o link
 * de "as falhas de ontem" para quem cuida do assunto, e volta pelo histórico do
 * navegador sem remontar o filtro.
 */

export const dynamic = 'force-dynamic'

/** Uma semana. É a janela em que ainda faz sentido reenviar alguma coisa. */
const DEFAULT_WINDOW_DAYS = 7

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CrmPage({ searchParams }: PageProps) {
  const params = await searchParams
  const me = await serverApi().me()

  const settings = await serverApi()
    .getSettings()
    .catch(() => null)
  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE

  const hoje = todayIn(timezone)
  const filters: BoardFilters = {
    from: asDate(params.from) ?? addDays(hoje, -(DEFAULT_WINDOW_DAYS - 1)),
    to: asDate(params.to) ?? hoje,
    status: asEnum(params.status, MessageStatusSchema.options),
    channel: asEnum(params.channel, MessageChannelSchema.options),
    category: asEnum(params.category, MessageCategorySchema.options),
    recipientKind: asEnum(params.recipientKind, MessageRecipientKindSchema.options),
  }
  const page = asPage(params.page)

  // A janela vai ao serviço como instante, não como data: `2026-08-29` em São Paulo
  // começa às 03:00Z, e mandar a data crua jogaria três horas de envios para o dia
  // errado — exatamente o erro que `zonedDayRange` existe para evitar.
  const range = {
    from: zonedDayRange(filters.from, timezone).from.toISOString(),
    to: zonedDayRange(filters.to, timezone).to.toISOString(),
  }

  const [stats, messages] = await Promise.all([
    serverApi()
      .getMessageStats(range)
      .catch(swallowApiError),
    serverApi()
      .listMessages({
        ...range,
        page,
        limit: 20,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.channel ? { channel: filters.channel } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.recipientKind ? { recipientKind: filters.recipientKind } : {}),
      })
      .catch(swallowApiError),
  ])

  const failed = stats instanceof ApiError || messages instanceof ApiError

  const canSend = me.permissions.includes('crm:send')

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Relacionamento"
        title="Mensagens"
        subtitle={
          failed
            ? 'O serviço não respondeu'
            : `${stats.sent} ${stats.sent === 1 ? 'enviada' : 'enviadas'} no período`
        }
        actions={
          <>
            <Link href="/crm/campanhas" className="btn btn-ghost">
              Campanhas
            </Link>
            <Link href="/crm/textos" className="btn btn-ghost">
              Textos
            </Link>
            <Link href="/crm/configuracoes" className="btn btn-ghost">
              Configuração
            </Link>
          </>
        }
      />

      {failed ? (
        <EmptyState
          title="O serviço não respondeu"
          description="O serviço de mensagens está indisponível agora. Recarregue em instantes."
        />
      ) : (
        <>
          <StuckQueueBanner stats={stats} />
          <StatsRow stats={stats} />
          <BlockedBreakdown blockedByReason={stats.blockedByReason} />
          <ChannelNotice />

          <MessagesBoard
            page={messages}
            filters={filters}
            timezone={timezone}
            canSend={canSend}
          />
        </>
      )}
    </div>
  )
}

/** `undefined` para o que não veio ou não é do enum: filtro inválido é filtro nenhum. */
function asEnum<T extends string>(
  value: string | string[] | undefined,
  options: readonly T[],
): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function asDate(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function asPage(value: string | string[] | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
}

function swallowApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  throw error
}
