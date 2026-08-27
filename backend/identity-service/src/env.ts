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

  /**
   * MOD-IDENT-06. `RESEND_API_KEY` é opcional de propósito: sem ela o convite é
   * criado do mesmo jeito e o link volta na resposta — ver `lib/mailer.ts`.
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * Sem default de propósito. Um remetente padrão seria de um domínio que ninguém
   * verificou no Resend, e a API responde 403 a esse envio — o convite seria criado
   * e o e-mail sumiria em silêncio. Faltando aqui, o mailer cai no modo de log, que
   * ao menos diz o que houve.
   */
  MAIL_FROM: z.string().min(1).optional(),
  /**
   * Base pública do frontend, para montar o link do convite. É a única variável do
   * backend que precisa saber o endereço do navegador; sem ela o e-mail sairia com
   * um link para `localhost`.
   */
  APP_URL: z.string().url().default('http://localhost:3002'),
  /** AC-01: o convite vale 7 dias. */
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
})

export type Env = ReturnType<typeof loadEnv>
