import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createCache } from './cache.js'
import { createEventPublisher } from './events.js'

/**
 * Cache e broker desligados são o estado normal da suíte de testes e o estado de
 * incidente em produção. Nos dois casos a regra é a mesma: o serviço segue de pé.
 *
 * Sem broker e sem Redis no ar, nenhuma chamada abaixo pode lançar nem travar — é o
 * que garante que uma queda de infra deixe o petshop lento, não parado.
 */

const logger = pino({ level: 'silent' })

interface EventosDeTeste {
  'teste.ocorrido': { timestamp: string; tenantId: string }
}

describe('degradação com a infra desligada', () => {
  const cache = createCache({
    logger,
    getUrl: () => 'redis://inexistente:6379',
    isDisabled: () => true,
  })

  it('o cache desligado devolve nulo e nunca abre conexão', async () => {
    expect(cache.getRedis()).toBeNull()
    await expect(cache.cacheGet('qualquer')).resolves.toBeNull()
  })

  it('escrita e invalidação viram no-op silencioso', async () => {
    await expect(cache.cacheSet('k', { a: 1 }, 60)).resolves.toBeUndefined()
    await expect(cache.cacheDelete('k1', 'k2')).resolves.toBeUndefined()
    await expect(cache.cacheDelete()).resolves.toBeUndefined()
    await expect(cache.closeRedis()).resolves.toBeUndefined()
  })

  it('o publicador desligado resolve sem lançar — o commit já aconteceu', async () => {
    const { publishEvent, closeEvents } = createEventPublisher<EventosDeTeste>({
      logger,
      getUrl: () => 'amqp://inexistente',
      isDisabled: () => true,
    })

    await expect(publishEvent('teste.ocorrido', { tenantId: 't1' })).resolves.toBeUndefined()
    await expect(closeEvents()).resolves.toBeUndefined()
  })

  it('broker fora do ar não derruba a operação de negócio', async () => {
    const { publishEvent } = createEventPublisher<EventosDeTeste>({
      logger,
      // Porta fechada de propósito: a conexão falha e o publish tem de engolir.
      getUrl: () => 'amqp://127.0.0.1:1',
      isDisabled: () => false,
    })

    await expect(publishEvent('teste.ocorrido', { tenantId: 't1' })).resolves.toBeUndefined()
  })
})
