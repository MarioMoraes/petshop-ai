import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closeHarness,
  givenTenant,
  givenTutor,
  hashPhone,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

const { encryptForTenant, withTenant } = await import('@petshop/db')
const { runAgentRetentionOnce } = await import('../../src/modules/agent/retention.js')

/**
 * §9 do PRD de agentes — a retenção do que o cliente escreveu.
 *
 * O que esta suíte prende não é o prazo: é **o que sobra**. O corpo do turno, o argumento
 * da tool e o vínculo com o titular somem; a linha, o custo e a contagem de turnos ficam,
 * porque é deles que o painel de qualidade vive. Um expurgo que apagasse a conversa
 * inteira passaria em qualquer teste de LGPD e jogaria fora a série de dois anos que diz
 * se o módulo se paga.
 */

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

/** Vinte e cinco meses: fora da janela por folga, para o teste não depender do mês. */
const ANTIGO = new Date(Date.now() - 25 * 30 * 86_400_000)
const RECENTE = new Date(Date.now() - 86_400_000)

interface ConversaSeed {
  lastTurnAt?: Date
  status?: 'ACTIVE' | 'HANDOFF' | 'ASSIGNED' | 'CLOSED'
  tutorId?: string
  phone?: string
  /** Deixa uma proposta viva pendurada, como a de um "sim" que nunca veio. */
  proposta?: boolean
}

/**
 * Uma conversa com um turno e uma chamada de tool, escrita direto.
 *
 * O caminho do webhook é exercitado à exaustão pelas outras suítes; o que esta precisa é
 * de uma linha com data de dois anos atrás, que nenhuma mensagem de verdade produziria.
 */
async function givenConversa(options: ConversaSeed = {}): Promise<string> {
  const lastTurnAt = options.lastTurnAt ?? ANTIGO
  const phone = options.phone ?? '+5511987654321'

  return withTenant(tenant.tenantId, async (tx) => {
    const conversa = await tx.agentConversation.create({
      data: {
        tenantId: tenant.tenantId,
        ...(options.tutorId ? { tutorId: options.tutorId } : {}),
        contactEncrypted: await encryptForTenant(tx, tenant.tenantId, phone),
        contactHash: hashPhone(phone),
        status: options.status ?? 'CLOSED',
        // Fila da recepção exige motivo — `agent_conversations_handoff_check`: handoff
        // sem motivo seria uma fila sem triagem.
        ...(options.status === 'HANDOFF' || options.status === 'ASSIGNED'
          ? { handoffReason: 'REQUESTED' as const, handoffAt: lastTurnAt }
          : {}),
        turnCount: 4,
        costMillicents: 1_234,
        lastTurnAt,
        closedAt: (options.status ?? 'CLOSED') === 'CLOSED' ? lastTurnAt : null,
      },
      select: { id: true },
    })

    await tx.agentTurn.create({
      data: {
        tenantId: tenant.tenantId,
        conversationId: conversa.id,
        role: 'TUTOR',
        contentEncrypted: await encryptForTenant(
          tx,
          tenant.tenantId,
          'o Thor toma remédio de coração, pode dar banho?',
        ),
        costMillicents: 300,
        createdAt: lastTurnAt,
      },
    })

    await tx.agentToolCall.create({
      data: {
        tenantId: tenant.tenantId,
        conversationId: conversa.id,
        tool: 'proporAgendamento',
        argumentsEncrypted: await encryptForTenant(
          tx,
          tenant.tenantId,
          '{"petId":"...","startsAt":"2024-08-01T13:00:00-03:00"}',
        ),
        resultSummary: 'proposta de horário',
        status: options.proposta ? 'PROPOSED' : 'EXECUTED',
        ...(options.proposta
          ? {
              confirmationToken: 'token-que-nao-deveria-sobreviver',
              expiresAt: new Date(lastTurnAt.getTime() + 15 * 60_000),
            }
          : {}),
        createdAt: lastTurnAt,
      },
    })

    return conversa.id
  })
}

function lerConversa(id: string) {
  return ownerPrisma.agentConversation.findUniqueOrThrow({ where: { id } })
}

function lerTurno(conversationId: string) {
  return ownerPrisma.agentTurn.findFirstOrThrow({ where: { conversationId } })
}

function lerToolCall(conversationId: string) {
  return ownerPrisma.agentToolCall.findFirstOrThrow({ where: { conversationId } })
}

describe('§9 — a retenção por idade', () => {
  it('esvazia o dado pessoal do que passou de 24 meses', async () => {
    const tutorId = await givenTutor(tenant)
    const velha = await givenConversa({ tutorId })

    const result = await runAgentRetentionOnce()

    expect(result.conversations).toBe(1)
    expect(result.turns).toBe(1)
    expect(result.toolCalls).toBe(1)

    const conversa = await lerConversa(velha)
    expect(conversa.contactEncrypted).toBe('')
    expect(conversa.tutorId).toBeNull()
    expect((await lerTurno(velha)).contentEncrypted).toBe('')
    expect((await lerToolCall(velha)).argumentsEncrypted).toBe('')
  })

  it('não toca no que está dentro da janela', async () => {
    const recente = await givenConversa({ lastTurnAt: RECENTE, phone: '+5511900000001' })

    expect((await runAgentRetentionOnce()).conversations).toBe(0)
    expect((await lerConversa(recente)).contactEncrypted).not.toBe('')
    expect((await lerTurno(recente)).contentEncrypted).not.toBe('')
  })

  /**
   * O que o expurgo **não** pode levar: sem a linha, o painel de qualidade perderia o
   * desfecho e o custo de dois anos de operação — a série que diz se o módulo se paga.
   */
  it('preserva a linha, a contagem de turnos e o custo', async () => {
    const velha = await givenConversa()

    await runAgentRetentionOnce()

    const conversa = await lerConversa(velha)
    expect(conversa.turnCount).toBe(4)
    expect(conversa.costMillicents).toBe(1_234)
    expect(await ownerPrisma.agentTurn.count({ where: { conversationId: velha } })).toBe(1)
    expect((await lerTurno(velha)).costMillicents).toBe(300)
  })

  /**
   * A conversa parada na fila da recepção continua `HANDOFF` para sempre — o varredor de
   * inatividade só mexe em `ACTIVE`, de propósito. Esvaziar o contato sem fechá-la
   * deixaria na fila uma linha sem nome e sem número que ninguém conseguiria atender.
   */
  it('encerra a conversa viva com a data do último turno, e vence a proposta pendurada', async () => {
    const parada = await givenConversa({ status: 'HANDOFF', proposta: true })

    await runAgentRetentionOnce()

    const conversa = await lerConversa(parada)
    expect(conversa.status).toBe('CLOSED')
    // A data do último turno, e não a de hoje: o painel lê por janela, e a janela desta
    // conversa passou há dois anos. `closedAt = agora` a contaria como desfecho da semana.
    expect(conversa.closedAt?.getTime()).toBe(conversa.lastTurnAt.getTime())

    const proposta = await lerToolCall(parada)
    expect(proposta.status).toBe('EXPIRED')
    expect(proposta.confirmationToken).toBeNull()
  })

  it('é idempotente: a segunda execução não reencontra a conversa esvaziada', async () => {
    await givenConversa()

    expect((await runAgentRetentionOnce()).conversations).toBe(1)
    expect((await runAgentRetentionOnce()).conversations).toBe(0)
  })

  it('varre em lotes até esvaziar', async () => {
    for (let i = 0; i < 5; i += 1) {
      await givenConversa({
        lastTurnAt: new Date(ANTIGO.getTime() - i * 60_000),
        phone: `+551190000000${i}`,
      })
    }

    process.env.AGENT_RETENTION_BATCH = '2'
    const { resetEnvCache } = await import('../../src/config/env.js')
    resetEnvCache()
    try {
      const result = await runAgentRetentionOnce()
      expect(result.conversations).toBe(5)
      expect(result.incomplete).toBe(false)
    } finally {
      delete process.env.AGENT_RETENTION_BATCH
      resetEnvCache()
    }

    const restantes = await ownerPrisma.agentConversation.count({
      where: { tenantId: tenant.tenantId, contactEncrypted: { not: '' } },
    })
    expect(restantes).toBe(0)
  })
})

describe('§9 — o titular que exerceu o art. 18', () => {
  /**
   * O schema e o `decryptOrPlaceholder` sempre disseram que a anonimização apaga o corpo
   * dos turnos. Até esta varredura existir, ninguém apagava: a conversa continuava
   * cifrada com a DEK do tenant, que não foi embora com o titular.
   */
  it('esvazia a conversa do tutor anonimizado sem esperar os 24 meses', async () => {
    const tutorId = await givenTutor(tenant)
    const recente = await givenConversa({ tutorId, lastTurnAt: RECENTE })

    expect((await runAgentRetentionOnce()).conversations).toBe(0)

    await withTenant(tenant.tenantId, (tx) =>
      tx.tutor.update({
        where: { id: tutorId },
        data: { status: 'ANONYMIZED', anonymizedAt: new Date(), phoneEncrypted: '', phoneHash: '' },
      }),
    )

    expect((await runAgentRetentionOnce()).conversations).toBe(1)

    const conversa = await lerConversa(recente)
    expect(conversa.tutorId).toBeNull()
    expect(conversa.contactEncrypted).toBe('')
    expect((await lerTurno(recente)).contentEncrypted).toBe('')
    expect((await lerToolCall(recente)).argumentsEncrypted).toBe('')
  })

  it('a conversa de um tutor ativo continua intacta', async () => {
    const tutorId = await givenTutor(tenant)
    const viva = await givenConversa({ tutorId, lastTurnAt: RECENTE, status: 'ACTIVE' })

    expect((await runAgentRetentionOnce()).conversations).toBe(0)

    const conversa = await lerConversa(viva)
    expect(conversa.status).toBe('ACTIVE')
    expect(conversa.tutorId).toBe(tutorId)
  })
})
