import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do identity-service, validada na subida.
 *
 * Falhar aqui, com o nome da variável faltante, é muito melhor do que descobrir a
 * ausência no meio de uma requisição.
 */

export const { loadEnv, resetEnvCache } = defineEnv('identity-service', {
  ...serviceEnvShape,
  IDENTITY_SERVICE_PORT: z.coerce.number().int().default(3001),

  CLERK_SECRET_KEY: z.string().min(1),

  /** Duração do trial (questão 3 do PRD §11; assumido 14 dias). */
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  /** AC-03 de MOD-IDENT-01: 5 tentativas antes de PROVISIONING_FAILED. */
  PROVISIONING_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PROVISIONING_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
})

export type Env = ReturnType<typeof loadEnv>
