import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { getMaintenancePrisma, withTenant } from '@petshop/db'
import {
  AGENT_DISCLOSURE,
  AGENT_HISTORY_TURNS,
  AGENT_MAX_CONVERSATION_MILLICENTS,
  AGENT_MAX_TURNS,
  AGENT_OUT_OF_HOURS,
  AgentTurnOutputSchema,
  type AgentHandoffReason,
  type AgentSentiment,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { openCipher, decryptOrPlaceholder } from './crypto.js'
import { getAgentMessagingPort } from './messaging-port.js'
import { costOf, getModelPort, type ModelUsage } from './model-port.js'
import { contextLine, systemPrompt } from './prompt.js'
import { loadSettings, monthlySpendCents, withinWindow } from './settings.js'
import { AGENT_TOOLS, runTool } from './tools.js'

/**
 * O turno do agente (MOD-AI-02, 03, 05 e 08).
 *
 * **Nada disto roda dentro do webhook.** A Evolution reenvia o que não recebe 2xx
 * rapidamente, e um turno com duas consultas leva dezenas de segundos — a mesma mensagem
 * chegaria de novo enquanto a primeira ainda estivesse sendo respondida. O webhook grava
 * e marca `pending_at`; quem responde é este arquivo, chamado logo depois da resposta
 * HTTP e, no que sobrar, pelo varredor da grade de jobs.
 *
 * O caminho é sempre o mesmo, e **toda saída que não é uma resposta é um handoff**: o
 * agente desligado, fora do horário, sem chave de provedor, sem orçamento, longo demais,
 * em impasse ou com o provedor fora do ar — em todos os casos a conversa termina na fila
 * da recepção (RN-08). A única coisa que ele nunca faz é ficar calado.
 */

/**
 * Quem dispara o turno depois de o webhook responder.
 *
 * Existe como ponto de injeção por uma razão de teste, e a razão é boa: o disparo padrão
 * é uma promessa solta, e uma suíte que corresse contra ela disputaria a posse da
 * conversa com o próprio código que está testando — às vezes o teste ganharia, às vezes o
 * disparo, e a falha apareceria uma vez a cada dez execuções. Os testes trocam o
 * agendador por um que só anota, e chamam `answer` quando querem.
 */
export type TurnScheduler = (tenantId: string, conversationId: string) => void

const fireAndForget: TurnScheduler = (tenantId, conversationId) => {
  void answer(tenantId, conversationId).catch((error: unknown) => {
    logger.error({ err: error, tenantId, conversationId }, 'turno do agente falhou')
  })
}

let scheduler: TurnScheduler = fireAndForget

export function setTurnScheduler(next: TurnScheduler | null): void {
  scheduler = next ?? fireAndForget
}

export function scheduleTurn(tenantId: string, conversationId: string): void {
  scheduler(tenantId, conversationId)
}

/** O teto de idas e voltas ao modelo dentro de **um** turno. */
const MAX_TOOL_ROUNDS = 5

/** Depois de três turnos sem consulta bem-sucedida, a conversa vai para gente. */
const UNRESOLVED_LIMIT = 3

/**
 * Assume o turno pendente desta conversa.
 *
 * `pending_at` é o carimbo e a posse ao mesmo tempo: quem vai responder o **move para
 * agora** num `UPDATE` condicional, e só um ganha. Um processo que morra no meio deixa o
 * carimbo velho, e o varredor o recolhe passados 90 segundos — é o mesmo desenho do lease
 * do despacho de mensagens, que já sobreviveu a um deploy no meio da fila.
 */
async function claim(tenantId: string, conversationId: string, olderThan: Date): Promise<boolean> {
  const claimed = await withTenant(tenantId, (tx) =>
    tx.agentConversation.updateMany({
      where: { id: conversationId, status: 'ACTIVE', pendingAt: { lte: olderThan } },
      data: { pendingAt: new Date() },
    }),
  )
  return claimed.count === 1
}

async function release(tenantId: string, conversationId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.agentConversation.updateMany({
      where: { id: conversationId },
      data: { pendingAt: null },
    }),
  )
}

export interface AnswerOptions {
  /** Só assume a conversa cuja posse é anterior a isto. O varredor manda 90s atrás. */
  claimOlderThan?: Date
}

/**
 * Responde uma conversa que tem turno do tutor esperando.
 *
 * **Nunca lança.** Quem a chama é um `void` depois da resposta do webhook, ou um job — e
 * nos dois casos uma exceção não teria quem a lesse. Toda falha vira handoff, que é a
 * resposta que o cliente do outro lado consegue usar.
 */
export async function answer(
  tenantId: string,
  conversationId: string,
  options: AnswerOptions = {},
): Promise<void> {
  const claimed = await claim(tenantId, conversationId, options.claimOlderThan ?? new Date())
  if (!claimed) return

  try {
    await respond(tenantId, conversationId)
  } catch (error) {
    logger.error({ err: error, tenantId, conversationId }, 'turno do agente falhou')
    // RN-09: o provedor fora do ar não chega ao tutor como erro — chega como "vou chamar
    // alguém". O que o cliente vê é uma frase; o que o log guarda é a causa.
    await handoff(tenantId, conversationId, 'ERROR', {
      say: 'Tive um problema para consultar isso agora. Já estou chamando alguém da equipe.',
    })
  } finally {
    await release(tenantId, conversationId)
  }
}

async function respond(tenantId: string, conversationId: string): Promise<void> {
  const settings = await loadSettings(tenantId)

  const conversation = await withTenant(tenantId, (tx) =>
    tx.agentConversation.findUnique({
      where: { id: conversationId },
      select: {
        status: true,
        tutorId: true,
        turnCount: true,
        costMillicents: true,
        unresolvedStreak: true,
      },
    }),
  )

  // A recepção assumiu enquanto o turno esperava, ou a conversa foi encerrada. O agente
  // não retoma o que já é de gente (RN-07).
  if (!conversation || conversation.status !== 'ACTIVE') return

  const tutorId = conversation.tutorId
  // Sem ficha o agente não fala: a fatia 1 já mandou a conversa para a fila, e responder
  // a um número desconhecido diria a ele que o número **não** está na base (AC-02).
  if (!tutorId) return

  // ─── As portas fechadas, em ordem de custo ────────────────────────────────

  if (!settings.enabled || !getModelPort().configured) {
    await handoff(tenantId, conversationId, 'DISABLED')
    return
  }

  if (!withinWindow(settings)) {
    await handoff(tenantId, conversationId, 'DISABLED', {
      say: AGENT_OUT_OF_HOURS.replaceAll('{{abre}}', settings.opensAt).replaceAll(
        '{{fecha}}',
        settings.closesAt,
      ),
    })
    return
  }

  if (conversation.turnCount > AGENT_MAX_TURNS) {
    await handoff(tenantId, conversationId, 'TOO_LONG', {
      say: 'Vou chamar alguém da equipe para continuar com você.',
    })
    return
  }

  if (conversation.costMillicents >= AGENT_MAX_CONVERSATION_MILLICENTS) {
    // AC-03 de MOD-AI-08: o teto degrada para gente, nunca para silêncio. O tutor não vê
    // diferença nenhuma — e é esse o ponto.
    await handoff(tenantId, conversationId, 'BUDGET', {
      say: 'Vou chamar alguém da equipe para continuar com você.',
    })
    return
  }

  const spent = await monthlySpendCents(tenantId)
  if (spent >= settings.monthlyCapCents) {
    logger.warn(
      { tenantId, spent, cap: settings.monthlyCapCents },
      'teto mensal do agente atingido',
    )
    await handoff(tenantId, conversationId, 'BUDGET', {
      say: 'Vou chamar alguém da equipe para continuar com você.',
    })
    return
  }

  // ─── O turno ──────────────────────────────────────────────────────────────

  const history = await loadHistory(tenantId, conversationId)
  if (history.messages.length === 0) return

  const now = new Date()
  const messages = [...history.messages]
  // A linha de contexto entra **na mensagem**, depois do último `cache_control`. No
  // prompt de sistema ela invalidaria o prefixo a cada turno (AC-04 de MOD-AI-02).
  const last = messages[messages.length - 1]
  if (last && last.role === 'user' && typeof last.content === 'string') {
    messages[messages.length - 1] = {
      role: 'user',
      content: `${contextLine(settings, now)}\n${last.content}`,
    }
  }

  const usage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let toolSucceeded = false
  let output: { reply: string; sentiment: AgentSentiment; handoff: boolean } | null = null

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await getModelPort().complete({
      system: systemPrompt(settings),
      tools: AGENT_TOOLS,
      messages,
      // A saída estruturada é pedida em todo turno: o modelo responde texto **ou** chama
      // tools, e quando responde precisa vir com sentimento e handoff junto. Uma segunda
      // chamada só para classificar dobraria o custo do módulo (AC-02 de MOD-AI-05).
      structured: true,
    })

    accumulate(usage, response.usage)

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      output = parseOutput(response.content)
      break
    }

    messages.push({ role: 'assistant', content: response.content })

    /**
     * Todos os `tool_result` voltam **numa mensagem só** — inclusive os que falharam.
     *
     * Dividi-los em mensagens separadas ensina o modelo a parar de pedir consultas em
     * paralelo; omitir o que falhou o faz esperar para sempre por um resultado que não
     * vem.
     */
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const toolUse of toolUses) {
      const outcome = await runTool(
        { tenantId, tutorId, timezone: settings.timezone },
        toolUse.name,
        toolUse.input,
      )
      if (!outcome.isError) toolSucceeded = true
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.text,
        ...(outcome.isError ? { is_error: true } : {}),
      })
    }

    messages.push({ role: 'user', content: results })
  }

  const cost = costOf(usage)
  recordMetric({ metric: 'agent_turn_cost_millicents', tenantId, value: cost, unit: 'millicents' })
  /**
   * O que denuncia prefixo quebrado **antes de a fatura chegar** (§10).
   *
   * Zero a partir do segundo turno de uma conversa quer dizer que alguma coisa entrou no
   * prefixo que não devia — uma data, uma lista em ordem instável — e que cada turno
   * passou a pagar o prompt inteiro de novo.
   */
  recordMetric({
    metric: 'agent_cache_read_tokens',
    tenantId,
    value: usage.cacheReadTokens,
    unit: 'tokens',
  })

  if (!output) {
    // Cinco rodadas de tool sem resposta: o modelo está em laço. Cobra-se o que foi
    // gasto e a conversa vai para gente.
    await persistTurn(tenantId, conversationId, {
      reply: '',
      sentiment: null,
      usage,
      cost,
      toolSucceeded,
    })
    await handoff(tenantId, conversationId, 'UNRESOLVED', {
      say: 'Vou chamar alguém da equipe para continuar com você.',
    })
    return
  }

  const disclosed = history.hasAgentTurn
  const reply = disclosed
    ? output.reply
    : `${AGENT_DISCLOSURE.replaceAll('{{petshop}}', settings.tenantName)}\n\n${output.reply}`

  await persistTurn(tenantId, conversationId, {
    reply: output.reply,
    sentiment: output.sentiment,
    usage,
    cost,
    toolSucceeded,
  })

  await say(tenantId, conversationId, tutorId, reply)

  /**
   * O impasse (AC-03 de MOD-AI-05): três turnos seguidos sem nenhuma consulta que desse
   * certo. Não é sobre o modelo errar a tool — é sobre a conversa não andar.
   */
  const streak = toolSucceeded ? 0 : conversation.unresolvedStreak + 1
  await withTenant(tenantId, (tx) =>
    tx.agentConversation.update({
      where: { id: conversationId },
      data: { unresolvedStreak: streak },
    }),
  )

  if (output.handoff) {
    // O sentimento decide o motivo: irritação alta é problema de produto, pedido
    // explícito é atendimento normal. Os dois vão para a mesma fila, com rótulos que a
    // recepção lê de forma diferente.
    await handoff(
      tenantId,
      conversationId,
      output.sentiment === 'NEGATIVE' ? 'SENTIMENT' : 'REQUESTED',
    )
    return
  }

  if (streak >= UNRESOLVED_LIMIT) {
    await handoff(tenantId, conversationId, 'UNRESOLVED')
  }
}

// ─── Peças ───────────────────────────────────────────────────────────────────

function accumulate(total: ModelUsage, delta: ModelUsage): void {
  total.inputTokens += delta.inputTokens
  total.outputTokens += delta.outputTokens
  total.cacheReadTokens += delta.cacheReadTokens
  total.cacheWriteTokens += delta.cacheWriteTokens
}

/**
 * A saída estruturada do turno.
 *
 * O bloco de texto vem no formato de `AGENT_TURN_OUTPUT_JSON_SCHEMA`, e ainda assim passa
 * pelo Zod: o schema do provedor garante a **forma**, e o nosso garante os limites que
 * ele não aceita declarar (o tamanho da resposta). Quando a validação falha, o turno vira
 * impasse — é melhor que mandar ao cliente um JSON cru.
 */
function parseOutput(
  content: Anthropic.ContentBlock[],
): { reply: string; sentiment: AgentSentiment; handoff: boolean } | null {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()

  if (!text) return null

  try {
    const parsed = AgentTurnOutputSchema.parse(JSON.parse(text))
    return { reply: parsed.reply, sentiment: parsed.sentiment, handoff: parsed.handoff }
  } catch {
    logger.warn('resposta do modelo fora do contrato de saída')
    return null
  }
}

interface History {
  messages: Anthropic.MessageParam[]
  hasAgentTurn: boolean
}

/**
 * O histórico da conversa, do mais antigo para o mais novo.
 *
 * Os últimos doze turnos. Uma conversa que passe disso já está a caminho do teto do
 * AC-03, e mandar a conversa inteira faria o prefixo crescer sem que o começo dela
 * ajudasse a responder a pergunta de agora.
 */
async function loadHistory(tenantId: string, conversationId: string): Promise<History> {
  return withTenant(tenantId, async (tx) => {
    const cipher = await openCipher(tx, tenantId)
    const rows = await tx.agentTurn.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: AGENT_HISTORY_TURNS,
      select: { role: true, contentEncrypted: true, kind: true },
    })

    const messages: Anthropic.MessageParam[] = []
    for (const row of [...rows].reverse()) {
      const content = decryptOrPlaceholder(cipher, row.contentEncrypted, '')
      if (!content) continue
      messages.push({
        // A resposta da recepção entra como fala do próprio agente: do ponto de vista do
        // cliente, foi o petshop que respondeu — e o modelo precisa saber o que já foi
        // dito para não repetir.
        role: row.role === 'TUTOR' ? 'user' : 'assistant',
        content,
      })
    }

    return { messages, hasAgentTurn: rows.some((row) => row.role === 'AGENT') }
  })
}

interface PersistedTurn {
  reply: string
  sentiment: AgentSentiment | null
  usage: ModelUsage
  cost: number
  toolSucceeded: boolean
}

async function persistTurn(
  tenantId: string,
  conversationId: string,
  turn: PersistedTurn,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const cipher = await openCipher(tx, tenantId)

    // O turno sem resposta também é gravado: ele custou dinheiro, e um gasto sem linha
    // seria um gasto que o painel de qualidade não explica.
    await tx.agentTurn.create({
      data: {
        tenantId,
        conversationId,
        role: 'AGENT',
        kind: 'TEXT',
        contentEncrypted: cipher.encrypt(turn.reply),
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cacheReadTokens: turn.usage.cacheReadTokens,
        costMillicents: turn.cost,
        ...(turn.sentiment ? { sentiment: turn.sentiment } : {}),
      },
    })

    await tx.agentConversation.update({
      where: { id: conversationId },
      data: {
        turnCount: { increment: 1 },
        costMillicents: { increment: turn.cost },
        lastTurnAt: new Date(),
      },
    })
  })
}

/** Manda a frase pelo motor do MOD-NOTIF. Falha de envio não derruba o turno. */
async function say(
  tenantId: string,
  conversationId: string,
  tutorId: string,
  text: string,
): Promise<void> {
  try {
    await getAgentMessagingPort().sendReply({
      actor: { tenantId },
      tutorId,
      conversationId,
      text,
      dedupeKey: `agent-say:${randomUUID()}`,
    })
  } catch (error) {
    // O motor desligado é o caso mais comum, e é configuração — não defeito. A conversa
    // continua na tela da equipe, com o que o agente teria dito.
    logger.error({ err: error, tenantId, conversationId }, 'não foi possível enviar a resposta')
  }
}

interface HandoffOptions {
  /** A frase que o tutor recebe antes de a conversa mudar de mãos. */
  say?: string
}

/**
 * Passa a conversa para a recepção (MOD-AI-05).
 *
 * Terminal: depois disto o agente não volta a responder na mesma conversa (RN-07). O
 * evento e a trilha saem daqui, e não de `conversations.ts`, porque o motivo é decisão
 * deste turno.
 */
async function handoff(
  tenantId: string,
  conversationId: string,
  reason: AgentHandoffReason,
  options: HandoffOptions = {},
): Promise<void> {
  const now = new Date()

  const conversation = await withTenant(tenantId, async (tx) => {
    const row = await tx.agentConversation.findUnique({
      where: { id: conversationId },
      select: { status: true, tutorId: true },
    })
    if (!row || row.status !== 'ACTIVE') return null

    await tx.agentConversation.update({
      where: { id: conversationId },
      data: { status: 'HANDOFF', handoffReason: reason, handoffAt: now, unresolvedStreak: 0 },
    })

    await recordAudit(tx, {
      tenantId,
      actorUserId: null,
      action: 'agent.handoff',
      entity: 'agent_conversations',
      entityId: conversationId,
      after: { reason },
    })

    return row
  })

  if (!conversation) return

  if (options.say && conversation.tutorId) {
    await say(tenantId, conversationId, conversation.tutorId, options.say)
  }

  recordMetric({ metric: 'agent_handoff_total', tenantId, value: 1, unit: reason })
  await publishEvent('agente.handoff', { tenantId, conversationId, reason })
}

/**
 * O varredor dos turnos que ficaram para trás.
 *
 * O caminho normal é o webhook responder 204 e chamar `answer` logo em seguida. Este job
 * existe para o que esse caminho perde: o processo que reinicia no meio de um turno, a
 * réplica que morre, o erro que escapa antes do `finally`. Noventa segundos é mais que o
 * turno mais lento — recolher antes disso seria roubar um turno em andamento e responder
 * duas vezes.
 */
export async function sweepPendingTurns(now: Date = new Date()): Promise<{ answered: number }> {
  const cutoff = new Date(now.getTime() - 90_000)

  const pending = await getMaintenancePrisma().agentConversation.findMany({
    where: { status: 'ACTIVE', pendingAt: { lte: cutoff } },
    select: { id: true, tenantId: true },
    take: 50,
  })

  for (const conversation of pending) {
    await answer(conversation.tenantId, conversation.id, { claimOlderThan: cutoff })
  }

  if (pending.length > 0) logger.info({ retomados: pending.length }, 'turnos do agente retomados')
  return { answered: pending.length }
}
