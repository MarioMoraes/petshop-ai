import type { ConsumeMessage } from 'amqplib'
import { Prisma } from '@petshop/db'
import { AppError } from '@petshop/shared-types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConsumerSpec } from '../../src/shared/event-consumer.js'
import '../harness.js'

const { isPermanentError, processMessage, RETRY_DELAYS_MS } = await import(
  '../../src/shared/event-consumer.js'
)

/**
 * O consumo de eventos (`shared/event-consumer.ts`).
 *
 * O que se prova aqui é a decisão sobre cada mensagem — confirmar, repetir, estacionar ou
 * largar —, com o canal dublado. É a parte que decidia errado: a falha ia para uma DLX
 * sem fila nenhuma ligada, e o evento sumia.
 */

function message(routingKey: string, payload: unknown = { ok: true }): ConsumeMessage {
  return {
    fields: { routingKey },
    content: Buffer.from(JSON.stringify(payload)),
  } as unknown as ConsumeMessage
}

function harness(handler: (payload: unknown) => Promise<unknown>, extra: Partial<ConsumerSpec> = {}) {
  const settled: string[] = []
  const sleeps: number[] = []
  let abandoned = false

  const spec: ConsumerSpec = {
    queue: 'teste.events',
    label: 'teste',
    handlers: { 'algo.aconteceu': handler },
    ...extra,
  }
  const settler = {
    ack: () => settled.push('ack'),
    park: () => settled.push('park'),
  }
  const options = {
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    isAbandoned: () => abandoned,
  }

  return {
    settled,
    sleeps,
    abandon: () => {
      abandoned = true
    },
    run: (msg: ConsumeMessage) => processMessage(spec, settler, msg, options),
  }
}

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('falhou', { code, clientVersion: 'teste' })
}

describe('processMessage', () => {
  it('confirma o evento que o handler processou', async () => {
    const h = harness(async () => undefined)

    expect(await h.run(message('algo.aconteceu'))).toBe('acked')
    expect(h.settled).toEqual(['ack'])
  })

  it('confirma sem processar o evento que esta fila não trata', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
    })

    expect(await h.run(message('outra.coisa'))).toBe('acked')
    expect(calls).toBe(0)
  })

  it('repete a falha transitória e confirma uma vez só quando passa', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      if (calls < 3) throw prismaError('P2034')
    })

    expect(await h.run(message('algo.aconteceu'))).toBe('acked')
    expect(calls).toBe(3)
    expect(h.sleeps).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]])
    expect(h.settled).toEqual(['ack'])
  })

  it('estaciona — e não descarta — o que continua falhando depois de todas as tentativas', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      throw new Error('banco fora')
    })

    expect(await h.run(message('algo.aconteceu'))).toBe('parked')
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1)
    expect(h.settled).toEqual(['park'])
  })

  it('estaciona na primeira tentativa o erro que repetir não muda', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      z.object({ tenantId: z.uuid() }).parse({})
    })

    expect(await h.run(message('algo.aconteceu'))).toBe('parked')
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  it('estaciona o corpo que não é JSON', async () => {
    const h = harness(async () => undefined)
    const broken = { fields: { routingKey: 'algo.aconteceu' }, content: Buffer.from('{') }

    expect(await h.run(broken as unknown as ConsumeMessage)).toBe('parked')
  })

  it('trata como sucesso o erro que o módulo declara como "já foi feito"', async () => {
    const h = harness(
      async () => {
        throw prismaError('P2002')
      },
      { isAlreadyApplied: (error) => error instanceof Prisma.PrismaClientKnownRequestError },
    )

    expect(await h.run(message('algo.aconteceu'))).toBe('acked')
    expect(h.settled).toEqual(['ack'])
  })

  it('larga a mensagem, sem confirmar, quando o processo encerra no meio da espera', async () => {
    const h = harness(async () => {
      h.abandon()
      throw new Error('banco fora')
    })

    // Sem ack nem nack: o canal que fecha devolve a mensagem ao broker.
    expect(await h.run(message('algo.aconteceu'))).toBe('abandoned')
    expect(h.settled).toEqual([])
  })
})

describe('isPermanentError', () => {
  it('validação, JSON e erro de domínio não passam sozinhos', () => {
    expect(isPermanentError(new z.ZodError([]))).toBe(true)
    expect(isPermanentError(new SyntaxError('json'))).toBe(true)
    expect(isPermanentError(new AppError('ERR_LEDGER_001', 'não'))).toBe(true)
    expect(isPermanentError(prismaError('P2002'))).toBe(true)
    expect(isPermanentError(prismaError('P2025'))).toBe(true)
  })

  it('conexão, tempo esgotado e conflito entre transações passam', () => {
    for (const code of ['P1001', 'P1017', 'P2024', 'P2028', 'P2034']) {
      expect(isPermanentError(prismaError(code))).toBe(false)
    }
    expect(isPermanentError(new Error('qualquer outra coisa'))).toBe(false)
  })
})
