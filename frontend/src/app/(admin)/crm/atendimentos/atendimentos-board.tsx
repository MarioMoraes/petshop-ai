'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AGENT_HANDOFF_LABELS,
  AGENT_REPLY_MAX,
  AGENT_TOOL_CALL_LABELS,
  type AgentConversationDetail,
  type AgentConversationStatus,
  type AgentConversationSummary,
  type AgentToolCallView,
  type PaginatedAgentConversations,
} from '@petshop/shared-types'
import { Alert, Badge, Button, Card, EmptyState, Tabs } from '@/components/ui'
import { AlertTriangleIcon, BellIcon, InboxIcon } from '@/components/icons'
import { Modal } from '@/components/modal'
import {
  assumirConversaAction,
  carregarConversaAction,
  encerrarConversaAction,
  responderConversaAction,
} from './actions'

/**
 * A fila e a janela da conversa.
 *
 * A conversa abre em `<Modal>`, e não num painel dentro do cartão: é um formulário que
 * responde a **uma linha de uma lista**, que é exatamente o caso que
 * `docs/design-formularios.md` reserva para o diálogo. E é o formato certo pelo que a
 * tarefa é — ler o que o cliente escreveu e responder exige a tela inteira, não uma
 * coluna espremida ao lado da fila.
 *
 * O tom do ícone é `icon-brand`, o mesmo de Mensagens no menu lateral: um tom por
 * domínio, repetido em toda superfície dele.
 */

const ABAS: { id: AgentConversationStatus; label: string }[] = [
  { id: 'HANDOFF', label: 'Na fila' },
  { id: 'ASSIGNED', label: 'Em atendimento' },
  { id: 'CLOSED', label: 'Encerradas' },
]

const VAZIO: Record<string, { title: string; description: string }> = {
  HANDOFF: {
    title: 'Ninguém esperando',
    description:
      'Quando um cliente mandar mensagem no WhatsApp do estabelecimento, ela aparece aqui.',
  },
  ASSIGNED: {
    title: 'Nenhum atendimento em andamento',
    description: 'As conversas que alguém da equipe assumiu ficam nesta aba até serem encerradas.',
  },
  CLOSED: {
    title: 'Nada encerrado ainda',
    description: 'As conversas já resolvidas ficam guardadas aqui.',
  },
}

interface Props {
  page: PaginatedAgentConversations
  status: AgentConversationStatus
  podeAtender: boolean
}

export function AtendimentosBoard({ page, status, podeAtender }: Props) {
  const router = useRouter()
  const [navegando, startTransition] = useTransition()
  const [aberta, setAberta] = useState<AgentConversationDetail | null>(null)
  const [abrindo, setAbrindo] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  function trocarAba(proxima: string) {
    startTransition(() => router.push(`/crm/atendimentos?status=${proxima}`))
  }

  function abrir(id: string) {
    setErro(null)
    setAbrindo(id)
    startTransition(async () => {
      const resultado = await carregarConversaAction(id)
      setAbrindo(null)
      if (resultado.ok) setAberta(resultado.data)
      else setErro(resultado.message)
    })
  }

  return (
    <div className="space-y-5">
      <Tabs tabs={ABAS} active={status} onSelect={trocarAba} />

      {erro && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não foi possível abrir">
          {erro}
        </Alert>
      )}

      {page.data.length === 0 ? (
        <EmptyState
          title={VAZIO[status]?.title ?? 'Nada por aqui'}
          description={VAZIO[status]?.description ?? ''}
        />
      ) : (
        <div className="space-y-3">
          {page.data.map((conversa) => (
            <LinhaConversa
              key={conversa.id}
              conversa={conversa}
              abrindo={abrindo === conversa.id}
              travado={navegando}
              onAbrir={() => abrir(conversa.id)}
            />
          ))}
        </div>
      )}

      {aberta && (
        <JanelaConversa
          conversa={aberta}
          podeAtender={podeAtender}
          onAtualizar={setAberta}
          onFechar={() => {
            setAberta(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function LinhaConversa({
  conversa,
  abrindo,
  travado,
  onAbrir,
}: {
  conversa: AgentConversationSummary
  abrindo: boolean
  travado: boolean
  onAbrir: () => void
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{conversa.tutorName ?? 'Número sem cadastro'}</span>
            <span className="hint">{conversa.contact}</span>
            {conversa.handoffReason && (
              <Badge tone={conversa.handoffReason === 'UNKNOWN_NUMBER' ? 'neutral' : 'accent'}>
                {AGENT_HANDOFF_LABELS[conversa.handoffReason]}
              </Badge>
            )}
          </div>

          {/* A última linha da conversa: é o que diz do que se trata sem precisar abrir. */}
          <p className="mt-2 line-clamp-2 text-sm text-muted">{conversa.lastMessage}</p>

          <p className="hint mt-2">
            {espera(conversa)}
            {conversa.assignedToName ? ` · com ${conversa.assignedToName}` : ''}
          </p>
        </div>

        <Button
          variant="ghost"
          onClick={onAbrir}
          busy={abrindo}
          busyLabel="Abrindo"
          disabled={travado && !abrindo}
        >
          Abrir
        </Button>
      </div>
    </Card>
  )
}

/**
 * Há quanto tempo, em palavras.
 *
 * O número vem do **servidor** (`waitingMinutes`), e não do relógio do navegador: a
 * página é renderizada no servidor e um cálculo feito aqui daria minutos diferentes para
 * duas pessoas olhando a mesma fila.
 */
function espera(conversa: AgentConversationSummary): string {
  const minutos = conversa.waitingMinutes
  if (conversa.status === 'CLOSED') return `${conversa.turnCount} mensagens`
  if (minutos < 1) return 'agora mesmo'
  if (minutos < 60) return `esperando há ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `esperando há ${horas}h`
  const dias = Math.floor(horas / 24)
  return `esperando há ${dias} ${dias === 1 ? 'dia' : 'dias'}`
}

function JanelaConversa({
  conversa,
  podeAtender,
  onAtualizar,
  onFechar,
}: {
  conversa: AgentConversationDetail
  podeAtender: boolean
  onAtualizar: (proxima: AgentConversationDetail) => void
  onFechar: () => void
}) {
  const [texto, setTexto] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startEnvio] = useTransition()
  const [agindo, startAcao] = useTransition()

  const encerrada = conversa.status === 'CLOSED'
  /**
   * A proposta que ainda espera o "sim" do cliente (MOD-AI-04).
   *
   * É a informação que muda o trabalho de quem acabou de assumir: responder sem saber
   * dela é oferecer de novo o que já foi oferecido, ou marcar em cima de uma proposta
   * viva. Uma por conversa, e o banco garante isso.
   */
  const aguardando = conversa.toolCalls.find((chamada) => chamada.status === 'PROPOSED')

  function responder() {
    const limpo = texto.trim()
    if (!limpo) return
    setErro(null)
    startEnvio(async () => {
      const resultado = await responderConversaAction(conversa.id, limpo)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      // A janela continua aberta: é uma conversa, e não um formulário que se fecha.
      setTexto('')
      onAtualizar(resultado.data)
    })
  }

  function assumir() {
    setErro(null)
    startAcao(async () => {
      const resultado = await assumirConversaAction(conversa.id)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      const atualizada = await carregarConversaAction(conversa.id)
      if (atualizada.ok) onAtualizar(atualizada.data)
    })
  }

  function encerrar() {
    setErro(null)
    startAcao(async () => {
      const resultado = await encerrarConversaAction(conversa.id)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      onFechar()
    })
  }

  return (
    <Modal
      open
      onClose={onFechar}
      icon={<BellIcon />}
      tone="icon-brand"
      eyebrow="Atendimento"
      title={conversa.tutorName ?? 'Número sem cadastro'}
      subtitle={conversa.contact}
      busy={enviando || agindo}
      /**
       * **Duas ações, no máximo** (`docs/design-formularios.md`, regra 8): a terceira
       * quebra a barra em duas linhas e joga a principal para baixo. Encerrar é a que
       * sai — ela desce para o pé do corpo, como a regra manda para o que não se quer
       * a um deslize do polegar da ação mais clicada.
       */
      footer={
        podeAtender && !encerrada ? (
          <>
            {!conversa.assignedTo && (
              <Button variant="ghost" onClick={assumir} busy={agindo} busyLabel="Assumindo">
                Assumir
              </Button>
            )}
            <Button
              variant="primary"
              onClick={responder}
              busy={enviando}
              busyLabel="Enviando"
              disabled={!conversa.canReply || texto.trim().length === 0}
            >
              Responder
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {erro && (
          <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não foi possível concluir">
            {erro}
          </Alert>
        )}

        {conversa.candidates.length > 0 && (
          <Alert
            tone="accent"
            role="status"
            icon={<InboxIcon />}
            title={
              conversa.candidates.length === 1
                ? 'Este telefone está numa ficha'
                : 'Este telefone está em mais de uma ficha'
            }
          >
            {conversa.candidates.map((candidato) => candidato.name).join(', ')}. Abra a ficha certa
            em Tutores para continuar o atendimento por lá.
          </Alert>
        )}

        {aguardando && (
          <Alert
            tone="accent"
            role="status"
            icon={<BellIcon />}
            title="Há uma proposta esperando o cliente responder"
          >
            {aguardando.resultSummary ?? 'O atendimento automático propôs uma mudança na agenda.'}{' '}
            Nada foi gravado ainda: ela vale até o cliente confirmar, e perde a validade se ele
            pedir outra coisa.
          </Alert>
        )}

        <ol className="space-y-3">
          {conversa.turns.map((turno) => (
            <li
              key={turno.id}
              className={turno.role === 'TUTOR' ? 'flex justify-start' : 'flex justify-end'}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                  turno.role === 'TUTOR' ? 'bg-black/5 text-ink' : 'bg-accent-soft text-accent-ink'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{turno.content}</p>
                <p className="hint mt-1.5 text-xs">
                  {turno.role === 'TUTOR' ? 'Cliente' : (turno.authorName ?? 'Equipe')}
                  {' · '}
                  {new Date(turno.createdAt).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </li>
          ))}
        </ol>

        {encerrada ? (
          <p className="hint">Esta conversa foi encerrada.</p>
        ) : conversa.canReply ? (
          podeAtender && (
            <label className="block">
              <span className="hint">Sua resposta</span>
              <textarea
                className="field mt-1 min-h-24"
                maxLength={AGENT_REPLY_MAX}
                value={texto}
                onChange={(event) => setTexto(event.target.value)}
                placeholder="Escreva a resposta que vai sair pelo WhatsApp do estabelecimento"
              />
            </label>
          )
        ) : (
          <Alert
            tone="accent"
            role="status"
            icon={<AlertTriangleIcon />}
            title="Ainda não dá para responder por aqui"
          >
            {conversa.replyBlockedReason}
          </Alert>
        )}

        <AcoesDoAgente chamadas={conversa.toolCalls} />

        {podeAtender && !encerrada && (
          <div className="pt-2">
            <button
              type="button"
              onClick={encerrar}
              disabled={agindo}
              className="text-sm text-subtle underline underline-offset-4 hover:text-muted disabled:opacity-60"
            >
              Encerrar conversa
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * O que o atendimento automático fez na conversa (MOD-AI-04).
 *
 * **Os argumentos não vêm do servidor** — estão cifrados e carregam id de pet, data e
 * horário, que não dizem nada a quem lê. O que diz é o resumo em claro; a consulta que
 * falhou fica junto da que deu certo, porque é ela que explica por que o cliente ficou
 * sem resposta.
 */
function AcoesDoAgente({ chamadas }: { chamadas: AgentToolCallView[] }) {
  if (chamadas.length === 0) return null

  return (
    <details className="rounded-xl bg-black/[0.03] px-4 py-3">
      <summary className="hint cursor-pointer select-none">
        O que o atendimento automático fez ({chamadas.length})
      </summary>

      <ul className="mt-3 space-y-2">
        {chamadas.map((chamada) => (
          <li key={chamada.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{chamada.resultSummary ?? chamada.tool}</span>
            {chamada.status !== 'EXECUTED' && (
              <Badge tone={selo(chamada.status)}>{AGENT_TOOL_CALL_LABELS[chamada.status]}</Badge>
            )}
            <span className="hint text-xs">
              {new Date(chamada.createdAt).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function selo(status: AgentToolCallView['status']): 'neutral' | 'accent' | 'success' | 'danger' {
  if (status === 'CONFIRMED') return 'success'
  if (status === 'PROPOSED') return 'accent'
  if (status === 'FAILED') return 'danger'
  return 'neutral'
}
