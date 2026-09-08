import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do backend, validada na subida.
 *
 * Um `env.ts` só para o processo inteiro. Cada fatia da consolidação traz para cá as
 * variáveis do serviço que absorveu, **com os mesmos nomes** — o `.env`, os composes e
 * os segredos do swarm não mudam por causa da mudança de arquitetura.
 *
 * Usa `serviceEnvShape`, e não `baseEnvShape`. Enquanto era só gateway o processo não
 * publicava evento nem decifrava PII; agora hospeda módulo de domínio que faz as duas
 * coisas, e pedir `RABBITMQ_URL` e `ENCRYPTION_KEK` deixou de ser exigir segredo que
 * ninguém usa.
 */

export const { loadEnv, resetEnvCache } = defineEnv('petshop-app', {
  ...serviceEnvShape,
  GATEWAY_PORT: z.coerce.number().int().default(3000),

  CLERK_SECRET_KEY: z.string().min(1),
  /** Origens autorizadas a apresentar tokens desta instância do Clerk. */
  CLERK_AUTHORIZED_PARTIES: z.string().default(''),

  /**
   * Os serviços que **ainda não migraram**.
   *
   * Some um por fatia. Quando a lista esvaziar, o `proxy.ts` inteiro sai junto — é o
   * marcador de progresso da consolidação.
   */
  IDENTITY_SERVICE_URL: z.string().url().default('http://localhost:3001'),
  TUTOR_SERVICE_URL: z.string().url().default('http://localhost:3003'),
  PET_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  MEDICAL_RECORD_SERVICE_URL: z.string().url().default('http://localhost:3005'),
  SCHEDULING_SERVICE_URL: z.string().url().default('http://localhost:3006'),
  BILLING_LEDGER_SERVICE_URL: z.string().url().default('http://localhost:3007'),
  CRM_AUTOMATION_SERVICE_URL: z.string().url().default('http://localhost:3009'),
  MESSAGING_SERVICE_URL: z.string().url().default('http://localhost:3010'),
  PORTAL_BFF_URL: z.string().url().default('http://localhost:3020'),

  /**
   * Domínio da instalação, usado para montar o host que emite o token do Portal.
   *
   * O `authorizedParties` do `@clerk/backend` é comparação de string **sem glob**, e o
   * Portal é servido em `{slug}.{APP_DOMAIN}` — um host por tenant, criado a qualquer
   * hora. Nenhuma lista estática cobre isso; o que cobre é derivar o host exato do slug
   * que veio na requisição e conferir contra ele.
   *
   * O módulo do site usa o mesmo valor para montar a URL canônica de um tenant. Era a
   * mesma variável nos dois serviços, com o mesmo default, e continua sendo uma só.
   */
  APP_DOMAIN: z.string().default('localhost:3002'),

  /** Origens aceitas pelo CORS (SPEC §7.4: CORS restritivo por domínio). */
  CORS_ORIGINS: z.string().default('http://localhost:3002'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // ---- MOD-SITE (fatia 1 da consolidação) ----

  /**
   * Onde bater para que o Next descarte a página em cache. Junto com `APP_DOMAIN`,
   * fecha o laço da revalidação; `SITE_REVALIDATE_SECRET` é o que impede qualquer um
   * na rede de forçar re-render em massa.
   */
  FRONTEND_INTERNAL_URL: z.string().default('http://localhost:3002'),
  SITE_REVALIDATE_SECRET: z.string().default('dev-site-revalidate-secret'),

  // Mídia da galeria. O mesmo bucket do álbum do pet, em prefixo próprio.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  R2_REGION: z.string().default('auto'),
  R2_ENDPOINT: z.string().optional(),
})

export type Env = ReturnType<typeof loadEnv>

export function listFromEnv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
