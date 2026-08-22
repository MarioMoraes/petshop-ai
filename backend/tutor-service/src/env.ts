import { z } from 'zod'

/**
 * Configuração do tutor-service, validada na subida.
 *
 * Nota sobre a porta: o PRD tutores_02 aponta 3002, mas essa porta já é do frontend
 * (`FRONTEND_PORT` no .env). O serviço fica em 3003 e o gateway resolve por
 * `TUTOR_SERVICE_URL` — nenhum código depende do número em si.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TUTOR_SERVICE_PORT: z.coerce.number().int().default(3003),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAINTENANCE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),

  INTERNAL_SERVICE_SECRET: z.string().min(16),

  ENCRYPTION_KEK: z.string().min(1),
  EMAIL_HASH_PEPPER: z.string().min(1),

  /** Questão 2 do PRD §11: ViaCEP gratuito, com o cadastro seguindo manual na falha. */
  VIACEP_BASE_URL: z.string().url().default('https://viacep.com.br/ws'),
  CEP_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  /** Questão 1 do PRD §11: 90 dias sem atendimento aplica a tag INATIVO. */
  INACTIVITY_THRESHOLD_DAYS: z.coerce.number().int().positive().default(90),

  DISABLE_EVENTS: z.coerce.boolean().default(false),
  DISABLE_REDIS: z.coerce.boolean().default(false),
  /** Desliga o lookup externo de CEP; os testes injetam a porta. */
  DISABLE_CEP_LOOKUP: z.coerce.boolean().default(false),
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
    throw new Error(`Configuração inválida do tutor-service:\n  ${missing}`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache(): void {
  cached = null
}
