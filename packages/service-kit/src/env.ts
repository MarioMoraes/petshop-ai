import { z } from 'zod'

/**
 * Carregamento e validação de configuração, comum a todo processo do backend.
 *
 * Cada serviço declara **só o que é seu** (a porta, as chaves de integração, os
 * limites de negócio) e recebe pronto o núcleo que ninguém consegue rodar sem: banco,
 * Redis, segredo do contrato de serviço. Validar na subida, com o nome da variável
 * faltante, é muito melhor do que descobrir a ausência no meio de uma requisição.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

/**
 * O que todo processo precisa — inclusive o gateway, que não fala com o broker nem
 * cifra nada.
 */
export const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAINTENANCE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1),

  INTERNAL_SERVICE_SECRET: z.string().min(16),

  DISABLE_REDIS: z.coerce.boolean().default(false),
} as const

/**
 * O núcleo dos serviços de domínio: acrescenta o broker e as chaves de cifra ao
 * `baseEnvShape`. O gateway fica de fora de propósito — ele não publica evento nem
 * decifra PII, e exigir `ENCRYPTION_KEK` dele seria pedir um segredo que ele não usa.
 */
export const serviceEnvShape = {
  ...baseEnvShape,

  RABBITMQ_URL: z.string().min(1),

  ENCRYPTION_KEK: z.string().min(1),
  EMAIL_HASH_PEPPER: z.string().min(1),

  /** Desligam broker e cache em teste, onde ambos são substituídos por dublês. */
  DISABLE_EVENTS: z.coerce.boolean().default(false),
} as const

export interface EnvLoader<T> {
  /**
   * Lê e valida a configuração, memoizando o resultado. O `source` existe para os
   * testes: em produção ninguém passa nada.
   */
  loadEnv: (source?: NodeJS.ProcessEnv) => T
  resetEnvCache: () => void
}

/**
 * Monta o par `loadEnv`/`resetEnvCache` de um serviço.
 *
 * O cache é por chamada de `defineEnv`, e não global, porque cada serviço tem o seu
 * módulo `env.ts` — dois serviços no mesmo processo (só acontece em teste) não
 * disputam a mesma memória.
 */
export function defineEnv<S extends z.ZodRawShape>(
  serviceName: string,
  shape: S,
): EnvLoader<z.infer<z.ZodObject<S>>> {
  const schema = z.object(shape)
  type Env = z.infer<z.ZodObject<S>>

  let cached: Env | null = null

  return {
    loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
      if (cached) return cached
      const parsed = schema.safeParse(source)
      if (!parsed.success) {
        const missing = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n  ')
        throw new Error(`Configuração inválida do ${serviceName}:\n  ${missing}`)
      }
      cached = parsed.data as Env
      return cached
    },
    resetEnvCache(): void {
      cached = null
    },
  }
}
