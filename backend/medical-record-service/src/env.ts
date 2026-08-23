import { z } from 'zod'

/**
 * Configuração do medical-record-service, validada na subida.
 *
 * Nota sobre a porta: o PRD prontuario_04 aponta 3004, que já é do pet-service —
 * a mesma colisão que fez o tutor-service sair de 3002 para 3003. A numeração real
 * segue a ordem de implementação (3000 gateway, 3001 identidade, 3002 frontend,
 * 3003 tutores, 3004 pets, **3005 prontuário**) e o gateway resolve por
 * `MEDICAL_RECORD_SERVICE_URL` — nenhum código depende do número em si.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MEDICAL_RECORD_SERVICE_PORT: z.coerce.number().int().default(3005),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAINTENANCE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),

  INTERNAL_SERVICE_SECRET: z.string().min(16),

  ENCRYPTION_KEK: z.string().min(1),
  EMAIL_HASH_PEPPER: z.string().min(1),

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
    throw new Error(`Configuração inválida do medical-record-service:\n  ${missing}`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache(): void {
  cached = null
}
