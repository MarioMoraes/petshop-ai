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
  MEDICAL_RECORD_SERVICE_URL: z.string().url().default('http://localhost:3005'),
  SCHEDULING_SERVICE_URL: z.string().url().default('http://localhost:3006'),
  BILLING_LEDGER_SERVICE_URL: z.string().url().default('http://localhost:3007'),
  /**
   * Destino do encaminhamento **e** do salto do MOD-CRM: o módulo decide quem recebe
   * a mensagem e pede ao messaging-service que entregue (§5 do PRD). Quando o
   * messaging migrar, o salto vira chamada de função e sobra só o encaminhamento.
   */
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

  // ---- MOD-TUTOR (fatia 6 da consolidação) ----
  VIACEP_BASE_URL: z.string().url().default('https://viacep.com.br/ws'),
  /** Desliga a consulta de CEP na suíte, que roda sem rede. */
  DISABLE_CEP_LOOKUP: z.coerce.boolean().default(false),
  CEP_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** Dias sem atendimento para um tutor entrar na régua de inatividade. */
  INACTIVITY_THRESHOLD_DAYS: z.coerce.number().int().positive().default(90),

  /** O gerador de PDF (MOD-DOC). Sem ele o documento fica pendente e o job reprocessa. */
  GOTENBERG_URL: z.string().optional(),
  // ---- MOD-NOTIF / MOD-CRM-01 (fatia 4 da consolidação) ----

  /**
   * `RESEND_API_KEY` e `MAIL_FROM` são opcionais de propósito: sem elas o adaptador de
   * e-mail vira log e a mensagem é marcada como enviada com `provider = 'log'`. É o
   * estado de desenvolvimento e o do primeiro deploy — travar a fila porque falta uma
   * chave transformaria um problema de entrega num problema de fila cheia.
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Remetente com domínio verificado no Resend. Sem ele o provedor recusa tudo. */
  MAIL_FROM: z.string().min(1).optional(),

  /**
   * Quantas mensagens o worker tira da fila por passada. Vinte é o teto por minuto
   * padrão (RN-05) — puxar mais do que se pode enviar só encheria memória.
   */
  DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * Evolution API — o canal WhatsApp (MOD-CRM-01).
   *
   * As três são opcionais pela mesma razão que `RESEND_API_KEY`: sem elas o canal fica
   * **indisponível** e a cascata `AUTO` cai para o e-mail. É o que permite rodar a
   * suíte inteira e o app de desenvolvimento sem um container de WhatsApp no ar.
   */
  EVOLUTION_API_URL: z.string().url().optional(),
  EVOLUTION_API_KEY: z.string().min(1).optional(),
  /**
   * Para onde a Evolution devolve o pareamento e as quedas de conexão. Precisa ser um
   * endereço que **ela** alcance: em desenvolvimento ela é container e o backend roda
   * no host (`host.docker.internal`); em produção os dois são containers na mesma rede.
   */
  EVOLUTION_WEBHOOK_URL: z.string().url().optional(),

  /**
   * O segredo do webhook do Resend (MOD-NOTIF-10).
   *
   * Opcional como as demais credenciais de provedor: sem ele a rota do webhook
   * **recusa tudo com 401**, e não o contrário — um endpoint que aceita qualquer
   * requisição quando falta configuração é uma porta para suprimir o endereço de
   * qualquer concorrente (AC-03). O painel do Resend o entrega no formato `whsec_…`.
   */
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
})

export type Env = ReturnType<typeof loadEnv>

export function listFromEnv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
