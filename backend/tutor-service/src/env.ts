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

  /**
   * O papel do aceite de termo (MOD-DOC-07 e 08).
   *
   * As duas pontas são **opcionais de propósito**, como no financeiro e no prontuário:
   * sem Gotenberg ou sem bucket, o aceite continua sendo registrado — que é o que tem
   * valor jurídico — e só o arquivo fica pendente, esperando o job de reprocesso.
   * Exigi-las na subida derrubaria o cadastro inteiro num ambiente que ainda não
   * configurou impressão de documento.
   */
  GOTENBERG_URL: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  /** R2 ignora região, mas o assinador SigV4 do SDK exige uma. */
  R2_REGION: z.string().default('auto'),
})

export type Env = ReturnType<typeof loadEnv>
