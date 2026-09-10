'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  MESSAGE_BLOCK_REASON_LABELS,
  MESSAGE_CATEGORY_LABELS,
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_RECIPIENT_KIND_LABELS,
  MESSAGE_STATUS_LABELS,
  templateLabelOf,
  type MessageStatus,
  type MessageSummary,
} from '@petshop/shared-types'
import { Badge, Button, Card, EmptyState, FormError } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { cancelMessageAction, retryMessageAction } from './actions'

/**
 * A lista de mensagens, usada pelo painel e pela ficha do tutor.
 *
 * É um componente só de propósito. As duas telas respondem à mesma pergunta — "o que
 * saiu para essa pessoa e o que aconteceu com isso" — e duas cópias divergiriam no
 * primeiro estado novo: uma mostraria `BLOCKED` como falha, a outra como bloqueio, e
 * o balcão passaria a receber respostas diferentes conforme onde olhasse.
 *
 * A diferença entre os dois usos cabe em `showTutor`: no painel a coluna de quem
 * recebeu é a mais importante; na ficha ela seria a mesma palavra vinte vezes.
 *
 * Desde o MOD-NOTIF-11 essa coluna tem **duas** relações. O selo "Equipe" só aparece
 * na linha de equipe: marcar as duas transformaria a informação em ruído, e a de
 * cliente é a esmagadora maioria.
 */

interface Props {
  messages: MessageSummary[]
  /** `crm:send`. Sem ela o botão de reenviar não aparece — a rota devolveria 403. */
  canSend: boolean
  showTutor: boolean
  /** Texto do vazio. Muda com o filtro: "nada ainda" e "o filtro não achou" são
   *  situações diferentes, e oferecer a mesma saída para as duas é ruído. */
  empty: { title: string; description: string }
}

export function MessageList({ messages, canSend, showTutor, empty }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  if (messages.length === 0) {
    return <EmptyState title={empty.title} description={empty.description} />
  }

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.ok) router.refresh()
      else setError(result.message ?? 'Não foi possível concluir a operação.')
    })
  }

  return (
    <div className="space-y-3">
      <FormError message={error} />

      {messages.map((message) => {
        const open = openId === message.id

        return (
          <Card key={message.id}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : message.id)}
              className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 text-left"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {templateLabelOf(message.templateKey)}
                  {showTutor && <span className="text-muted"> · {message.recipientName}</span>}
                  {showTutor && message.recipientKind === 'USER' && (
                    <span className="ml-2 inline-flex align-middle">
                      <Badge>{MESSAGE_RECIPIENT_KIND_LABELS[message.recipientKind]}</Badge>
                    </span>
                  )}
                </p>
                <p className="hint mt-0.5">
                  {formatMoment(message)} · {MESSAGE_CHANNEL_LABELS[message.channel]} ·{' '}
                  {MESSAGE_CATEGORY_LABELS[message.category]}
                </p>
              </div>
              <StatusBadge status={message.status} />
            </button>

            {open && (
              <div className="mt-4 space-y-4 border-t border-line pt-4">
                {message.subject && <p className="text-sm font-medium">{message.subject}</p>}

                {/*
                 * O corpo é o que a mensagem realmente dizia — renderizado na entrada
                 * da fila, não agora (RN-14). Editar o template depois não reescreve o
                 * que já saiu, e é por isso que ele vale como prova do que foi dito.
                 */}
                <p className="whitespace-pre-wrap text-sm text-muted">{message.body}</p>

                {message.blockReason && (
                  <p className="text-sm text-danger">
                    {MESSAGE_BLOCK_REASON_LABELS[message.blockReason]}
                  </p>
                )}

                {message.errorCode && (
                  <p className="hint">
                    Erro do provedor: {message.errorCode}
                    {message.errorDetail ? ` — ${message.errorDetail}` : ''}
                  </p>
                )}

                <Timeline message={message} />

                <div className="flex flex-wrap items-center gap-2">
                  {showTutor && (
                    <ButtonLink href={`/tutores/${message.tutorId}`} variant="ghost">
                      Abrir a ficha
                    </ButtonLink>
                  )}

                  {canSend && canRetry(message.status) && (
                    <Button
                      type="button"
                      busy={pending}
                      onClick={() => run(() => retryMessageAction(message.id))}
                      busyLabel="Reenviando…"
                    >
                      Tentar de novo
                    </Button>
                  )}

                  {canCancel(message.status) && (
                    <Button
                      type="button"
                      variant="ghost"
                      busy={pending}
                      onClick={() => run(() => cancelMessageAction(message.id))}
                      busyLabel="Cancelando…"
                    >
                      Cancelar o envio
                    </Button>
                  )}
                </div>

                {canSend && canRetry(message.status) && (
                  <p className="hint">
                    O reenvio confere consentimento e supressão de novo — quem pediu para não
                    receber continua não recebendo.
                  </p>
                )}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}

/**
 * Só falha se reenvia. Bloqueio não é falha: o conserto é no cadastro (RN-03).
 *
 * `SENDING` entra porque numa tela ele nunca é o que parece. O envio de verdade dura
 * segundos, e o varredor do motor desfaz a posse abandonada em dez minutos — quem vê
 * "Enviando" numa listagem está vendo o resto de um processo que morreu no meio.
 */
function canRetry(status: MessageStatus): boolean {
  return status === 'DEAD' || status === 'FAILED' || status === 'SENDING'
}

/** Só se cancela o que ainda não saiu. */
function canCancel(status: MessageStatus): boolean {
  return status === 'QUEUED' || status === 'SCHEDULED'
}

function StatusBadge({ status }: { status: MessageStatus }) {
  const tone =
    status === 'DELIVERED' || status === 'READ' || status === 'SENT'
      ? 'success'
      : status === 'FAILED' || status === 'DEAD' || status === 'BLOCKED'
        ? 'danger'
        : 'neutral'

  return <Badge tone={tone}>{MESSAGE_STATUS_LABELS[status]}</Badge>
}

/**
 * As datas que a mensagem colecionou, na ordem em que aconteceram.
 *
 * Só as que existem: uma linha "Lida: —" ocupa espaço para dizer que o WhatsApp ainda
 * não confirmou leitura, o que não é informação.
 */
function Timeline({ message }: { message: MessageSummary }) {
  const moments: [string, string | null][] = [
    ['Criada', message.createdAt],
    ['Agendada para', message.scheduledFor],
    ['Enviada', message.sentAt],
    ['Entregue', message.deliveredAt],
    ['Lida', message.readAt],
    ['Falhou', message.failedAt],
  ]

  const shown = moments.filter(([, value]) => value !== null)

  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {shown.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="hint">{label}</dt>
          <dd className="tabular-nums">{formatDateTime(value!)}</dd>
        </div>
      ))}
      {message.attempts > 0 && (
        <div className="flex justify-between gap-3">
          <dt className="hint">Tentativas</dt>
          <dd className="tabular-nums">{message.attempts}</dd>
        </div>
      )}
    </dl>
  )
}

/**
 * O instante que importa na linha fechada.
 *
 * Para o que já saiu é o envio; para o que ainda espera, a hora marcada; para o resto,
 * quando entrou na fila. Mostrar sempre `createdAt` faria uma mensagem agendada para
 * a semana que vem parecer coisa de hoje.
 */
function formatMoment(message: MessageSummary): string {
  return formatDateTime(message.sentAt ?? message.scheduledFor ?? message.createdAt)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
