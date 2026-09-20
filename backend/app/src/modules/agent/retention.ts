import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { loadEnv } from '../../config/env.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { close } from './conversations.js'

/**
 * A retenção do que o cliente escreveu (§9 do PRD de agentes).
 *
 * **O que sai é o dado pessoal; o que fica é a contagem.** A tabela do §9 dá 24 meses a
 * `agent_turns.content_encrypted`, a `agent_tool_calls.arguments` e ao
 * `agent_conversations.tutor_id` — e é exatamente o recorte que a anonimização do titular
 * já fazia na linha do schema: a conversa deixa de existir como dado pessoal e sobra o
 * número, que é o que o painel de qualidade conta. Apagar a linha inteira seria mais
 * simples e jogaria fora o custo e o desfecho de dois anos de operação, que é a série que
 * diz se o módulo se paga.
 *
 * É por isso que este expurgo **atualiza** onde o do MOD-SEC apaga: lá a linha inteira é
 * o dado pessoal; aqui ela é um turno de uma conversa que também é estatística.
 *
 * **Duas varreduras, um mesmo esvaziamento.** A primeira é a idade; a segunda é o titular
 * que exerceu o art. 18 — `anonymizeTutor` solta o vínculo do lado do tutor e nada, até
 * aqui, esvaziava o corpo do que ele escreveu ao agente. O atraso de até um dia é o
 * mesmo do expurgo dos corpos de mensagem, e cabe com folga no prazo de resposta ao
 * titular.
 *
 * **O que a segunda varredura não alcança** é a conversa que nunca foi reconhecida:
 * `tutor_id` nulo é número que ninguém identificou, e a anonimização apaga justamente o
 * `phone_hash` que ligaria os dois. Essa sai pela idade, como qualquer outra.
 *
 * **Descobrir é cross-tenant; agir sobre um registro nunca é.** A busca sai do cliente de
 * manutenção, e cada conversa é esvaziada dentro de `withTenant()` — a RLS é o teto que
 * contém um erro de aritmética de data em um tenant, em vez de em todos.
 */

/** O que a linha esvaziada guarda no lugar do texto. É também a marca de "já passou". */
const VAZIO = ''

export interface AgentRetentionResult {
  /** Conversas des-identificadas nesta execução. */
  conversations: number
  turns: number
  toolCalls: number
  /** `true` quando o teto de tempo cortou a execução — o resto fica para amanhã. */
  incomplete: boolean
}

interface StaleConversation {
  id: string
  tenantId: string
  status: string
  lastTurnAt: Date
}

export async function runAgentRetentionOnce(now = new Date()): Promise<AgentRetentionResult> {
  const env = loadEnv()
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - env.AGENT_RETENTION_MONTHS)
  const deadline = now.getTime() + env.AGENT_RETENTION_MAX_MS
  const batch = env.AGENT_RETENTION_BATCH

  const result: AgentRetentionResult = {
    conversations: 0,
    turns: 0,
    toolCalls: 0,
    incomplete: false,
  }

  await purge(() => findAged(cutoff, batch), batch, deadline, result)
  await purge(() => findAnonymized(batch), batch, deadline, result)

  recordMetric({
    metric: 'agent_retention_conversations',
    value: result.conversations,
    unit: 'count',
  })
  recordMetric({ metric: 'agent_retention_turns', value: result.turns, unit: 'count' })

  if (result.conversations > 0) {
    logger.info({ ...result, cutoff: cutoff.toISOString() }, 'expurgo do agente concluído')
  }

  return result
}

/**
 * O laço de lotes.
 *
 * A primeira execução depois de dois anos de operação é a maior de todas, e um laço sem
 * teto a colocaria de pé no mesmo horário do backup. O job é diário e idempotente: a
 * conversa já esvaziada não volta a ser encontrada, porque o contato vazio **é** a marca.
 */
async function purge(
  find: () => Promise<StaleConversation[]>,
  batch: number,
  deadline: number,
  result: AgentRetentionResult,
): Promise<void> {
  for (;;) {
    if (Date.now() > deadline) {
      result.incomplete = true
      logger.warn(
        { conversations: result.conversations },
        'expurgo do agente interrompido pelo teto de tempo; retoma amanhã',
      )
      return
    }

    const rows = await find()
    for (const row of rows) {
      const wiped = await wipe(row)
      result.conversations += 1
      result.turns += wiped.turns
      result.toolCalls += wiped.toolCalls
    }

    if (rows.length < batch) return
  }
}

/** Conversas cujo último turno passou da janela do §9. */
function findAged(cutoff: Date, batch: number): Promise<StaleConversation[]> {
  return getMaintenancePrisma().agentConversation.findMany({
    where: { lastTurnAt: { lt: cutoff }, contactEncrypted: { not: VAZIO } },
    select: { id: true, tenantId: true, status: true, lastTurnAt: true },
    orderBy: { lastTurnAt: 'asc' },
    take: batch,
  })
}

/** Conversas de quem exerceu o art. 18 — sem esperar os 24 meses. */
function findAnonymized(batch: number): Promise<StaleConversation[]> {
  return getMaintenancePrisma().agentConversation.findMany({
    where: { contactEncrypted: { not: VAZIO }, tutor: { anonymizedAt: { not: null } } },
    select: { id: true, tenantId: true, status: true, lastTurnAt: true },
    orderBy: { lastTurnAt: 'asc' },
    take: batch,
  })
}

/**
 * Esvazia uma conversa, dentro do tenant dela.
 *
 * **A conversa viva é encerrada junto, e com a data do último turno.** Uma que ficou
 * dois anos na fila da recepção continua `HANDOFF` — o varredor de inatividade só mexe em
 * `ACTIVE`, de propósito —, e esvaziar o contato sem fechá-la deixaria na fila uma linha
 * sem nome e sem número que ninguém conseguiria atender. `close()` também vence a
 * proposta pendurada, que é o mesmo que ele faz no encerramento normal.
 *
 * O encerramento **não publica evento**: `agent.conversa_encerrada` anunciaria hoje um
 * fato de dois anos atrás, e quem o consome contaria como desfecho desta semana uma
 * conversa que acabou antes da última troca de plano. Pela mesma razão o `closedAt` é o
 * último turno, e não agora — o painel de qualidade lê por janela, e a janela dela já
 * passou.
 *
 * `confirmation_token` sai junto do argumento: o prazo de 15 minutos já o tornou inócuo,
 * mas uma chave de escrita que viajou pelo WhatsApp não tem por que sobreviver ao dado
 * que ela autorizava.
 */
async function wipe(row: StaleConversation): Promise<{ turns: number; toolCalls: number }> {
  return withTenant(row.tenantId, async (tx) => {
    if (row.status !== 'CLOSED') await close(tx, row.id, row.lastTurnAt)

    const turns = await tx.agentTurn.updateMany({
      where: { conversationId: row.id, contentEncrypted: { not: VAZIO } },
      data: { contentEncrypted: VAZIO },
    })

    const toolCalls = await tx.agentToolCall.updateMany({
      where: { conversationId: row.id, argumentsEncrypted: { not: VAZIO } },
      data: { argumentsEncrypted: VAZIO, confirmationToken: null },
    })

    // O contato vazio é o que faz a próxima execução não reencontrar esta linha — e o
    // hash vazio é o que impede uma mensagem nova de cair numa conversa desidentificada.
    await tx.agentConversation.update({
      where: { id: row.id },
      data: { contactEncrypted: VAZIO, contactHash: VAZIO, tutorId: null },
    })

    return { turns: turns.count, toolCalls: toolCalls.count }
  })
}
