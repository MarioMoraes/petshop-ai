import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { baseEnvShape, defineEnv, serviceEnvShape } from './env.js'

/** Um ambiente mínimo que satisfaz `serviceEnvShape`. */
const VALID = {
  DATABASE_URL: 'postgres://localhost/x',
  DATABASE_MAINTENANCE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost',
  INTERNAL_SERVICE_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEK: 'kek',
  EMAIL_HASH_PEPPER: 'pepper',
} satisfies NodeJS.ProcessEnv

describe('defineEnv', () => {
  it('aplica os padrões e valida o que o serviço acrescenta', () => {
    const { loadEnv } = defineEnv('teste', {
      ...serviceEnvShape,
      PORTA: z.coerce.number().int().default(3009),
    })

    const env = loadEnv({ ...VALID })

    expect(env.PORTA).toBe(3009)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.NODE_ENV).toBe('development')
    expect(env.DISABLE_EVENTS).toBe(false)
  })

  it('nomeia o serviço e a variável faltante na mensagem de erro', () => {
    const { loadEnv } = defineEnv('scheduling-service', serviceEnvShape)
    const { RABBITMQ_URL: _omitido, ...semBroker } = VALID

    expect(() => loadEnv(semBroker)).toThrow(/scheduling-service/)
    expect(() => loadEnv(semBroker)).toThrow(/RABBITMQ_URL/)
  })

  it('recusa segredo de serviço curto demais — o contrato HMAC depende dele', () => {
    const { loadEnv } = defineEnv('teste', serviceEnvShape)

    expect(() => loadEnv({ ...VALID, INTERNAL_SERVICE_SECRET: 'curto' })).toThrow(
      /INTERNAL_SERVICE_SECRET/,
    )
  })

  it('memoiza a leitura, e `resetEnvCache` a solta de novo', () => {
    const { loadEnv, resetEnvCache } = defineEnv('teste', serviceEnvShape)

    expect(loadEnv({ ...VALID, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug')
    // Sem reset, a segunda leitura devolve a primeira — é o que evita reparsear o
    // ambiente a cada `loadEnv()` dentro de uma requisição.
    expect(loadEnv({ ...VALID, LOG_LEVEL: 'trace' }).LOG_LEVEL).toBe('debug')

    resetEnvCache()
    expect(loadEnv({ ...VALID, LOG_LEVEL: 'trace' }).LOG_LEVEL).toBe('trace')
  })

  it('o cache é por serviço: dois `defineEnv` não disputam a mesma memória', () => {
    const a = defineEnv('a', serviceEnvShape)
    const b = defineEnv('b', serviceEnvShape)

    a.loadEnv({ ...VALID, LOG_LEVEL: 'debug' })

    expect(b.loadEnv({ ...VALID, LOG_LEVEL: 'warn' }).LOG_LEVEL).toBe('warn')
  })

  it('`baseEnvShape` não exige broker nem chave de cifra — é o caso do gateway', () => {
    const { loadEnv } = defineEnv('api-gateway', baseEnvShape)
    const { RABBITMQ_URL: _a, ENCRYPTION_KEK: _b, EMAIL_HASH_PEPPER: _c, ...semExtras } = VALID

    expect(() => loadEnv(semExtras)).not.toThrow()
  })
})
