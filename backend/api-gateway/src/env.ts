import { baseEnvShape, defineEnv } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do api-gateway, validada na subida.
 *
 * Usa `baseEnvShape`, e não `serviceEnvShape`: o gateway não publica evento nem
 * decifra PII, e pedir a ele `RABBITMQ_URL` ou `ENCRYPTION_KEK` seria exigir
 * segredos que ele nunca usa.
 */

export const { loadEnv, resetEnvCache } = defineEnv('api-gateway', {
  ...baseEnvShape,
  GATEWAY_PORT: z.coerce.number().int().default(3000),

  CLERK_SECRET_KEY: z.string().min(1),
  /** Origens autorizadas a apresentar tokens desta instância do Clerk. */
  CLERK_AUTHORIZED_PARTIES: z.string().default(''),

  IDENTITY_SERVICE_URL: z.string().url().default('http://localhost:3001'),
  TUTOR_SERVICE_URL: z.string().url().default('http://localhost:3003'),
  PET_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  MEDICAL_RECORD_SERVICE_URL: z.string().url().default('http://localhost:3005'),
  SCHEDULING_SERVICE_URL: z.string().url().default('http://localhost:3006'),
  BILLING_LEDGER_SERVICE_URL: z.string().url().default('http://localhost:3007'),

  /** Origens aceitas pelo CORS (SPEC §7.4: CORS restritivo por domínio). */
  CORS_ORIGINS: z.string().default('http://localhost:3002'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
})

export type Env = ReturnType<typeof loadEnv>

export function listFromEnv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
