import { z } from 'zod'

/**
 * Configuração do pet-service, validada na subida.
 *
 * Nota sobre a porta: o PRD pets_03 aponta 3003, que já é do tutor-service (que por
 * sua vez saiu de 3002 porque essa é do frontend). O serviço fica em 3004 e o
 * gateway resolve por `PET_SERVICE_URL` — nenhum código depende do número em si.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PET_SERVICE_PORT: z.coerce.number().int().default(3004),
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

  /**
   * Storage das fotos (MOD-PET-04) — R2 pela API S3.
   *
   * Opcionais de propósito: o serviço sobe sem eles e só o álbum deixa de funcionar,
   * devolvendo 502 `ERR_PET_009`. Exigi-los na subida derrubaria o cadastro de pets
   * inteiro em um ambiente que ainda não configurou o bucket.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  /** R2 ignora região, mas o assinador SigV4 do SDK exige uma. */
  R2_REGION: z.string().default('auto'),
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
    throw new Error(`Configuração inválida do pet-service:\n  ${missing}`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache(): void {
  cached = null
}
