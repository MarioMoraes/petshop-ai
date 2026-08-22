import { z } from 'zod'

/**
 * Configuração do identity-service, validada na subida.
 *
 * Falhar aqui, com o nome da variável faltante, é muito melhor do que descobrir a
 * ausência no meio de uma requisição.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  IDENTITY_SERVICE_PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAINTENANCE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),

  CLERK_SECRET_KEY: z.string().min(1),

  INTERNAL_SERVICE_SECRET: z.string().min(16),

  ENCRYPTION_KEK: z.string().min(1),
  EMAIL_HASH_PEPPER: z.string().min(1),

  /** Duração do trial (questão 3 do PRD §11; assumido 14 dias). */
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  /** AC-03 de MOD-IDENT-01: 5 tentativas antes de PROVISIONING_FAILED. */
  PROVISIONING_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PROVISIONING_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),

  /** Desliga broker e cache em teste, onde eles são substituídos por dublês. */
  DISABLE_EVENTS: z.coerce.boolean().default(false),
  DISABLE_REDIS: z.coerce.boolean().default(false),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n  ')
    throw new Error(`Configuração inválida do identity-service:\n  ${missing}`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache(): void {
  cached = null
}
