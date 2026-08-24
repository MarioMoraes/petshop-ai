import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do tutor-service, validada na subida.
 *
 * Nota sobre a porta: o PRD tutores_02 aponta 3002, mas essa porta já é do frontend
 * (`FRONTEND_PORT` no .env). O serviço fica em 3003 e o gateway resolve por
 * `TUTOR_SERVICE_URL` — nenhum código depende do número em si.
 */

export const { loadEnv, resetEnvCache } = defineEnv('tutor-service', {
  ...serviceEnvShape,
  TUTOR_SERVICE_PORT: z.coerce.number().int().default(3003),

  /** Questão 2 do PRD §11: ViaCEP gratuito, com o cadastro seguindo manual na falha. */
  VIACEP_BASE_URL: z.string().url().default('https://viacep.com.br/ws'),
  CEP_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  /** Questão 1 do PRD §11: 90 dias sem atendimento aplica a tag INATIVO. */
  INACTIVITY_THRESHOLD_DAYS: z.coerce.number().int().positive().default(90),

  /** Desliga o lookup externo de CEP; os testes injetam a porta. */
  DISABLE_CEP_LOOKUP: z.coerce.boolean().default(false),
})

export type Env = ReturnType<typeof loadEnv>
