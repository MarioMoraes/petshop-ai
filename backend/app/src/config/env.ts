import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do backend, validada na subida.
 *
 * Um `env.ts` só para o processo inteiro. Cada fatia da consolidação trouxe para cá as
 * variáveis do serviço que absorveu, **com os mesmos nomes** — o `.env`, os composes e
 * os segredos do swarm não mudaram por causa da mudança de arquitetura.
 *
 * **A lista de `*_SERVICE_URL` acabou na fatia 11**, e era o marcador de progresso da
 * consolidação: sumia uma por fatia. A última, `PORTAL_BFF_URL`, saiu com o `proxy.ts`.
 * O MOD-PORTAL não trouxe variável nova nenhuma — `APP_DOMAIN`, `GOTENBERG_URL` e as
 * cinco do R2 já estavam aqui, com os mesmos defaults.
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
   * O segredo do webhook do Clerk (MOD-IDENT-03).
   *
   * Mesmo desenho do `RESEND_WEBHOOK_SECRET`: opcional, porque nem toda instalação
   * configura o endpoint, e **sem ele a rota recusa tudo com 401**. O painel do Clerk o
   * entrega no formato `whsec_…` ao criar o endpoint, e ele é diferente da
   * `CLERK_SECRET_KEY` — um assina a entrega, o outro autentica a nossa chamada à API
   * deles.
   */
  CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),

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

  // ---- Camada comercial (fatia 4): a assinatura, cobrada pelo Asaas ----

  /**
   * A chave da API do Asaas (`access_token`). Opcional como as outras de provedor: sem
   * ela a tela de assinatura abre, mostra o plano e diz que a cobrança não está
   * configurada — o `POST` responde 503, e nada finge ter cobrado.
   */
  ASAAS_API_KEY: z.string().min(1).optional(),
  /**
   * **O sandbox é o padrão**, e produção é escolha explícita. Uma instalação nova que
   * esquecesse esta variável cobraria de verdade com uma chave de teste — que o Asaas
   * recusaria, mas o erro apareceria para o cliente e não no deploy.
   */
  ASAAS_API_URL: z.string().url().default('https://api-sandbox.asaas.com/v3'),
  /**
   * O token que o Asaas manda em `asaas-access-token` a cada webhook, cadastrado no
   * painel dele. Sem ele a rota recusa tudo com 401, pela mesma razão do Resend: um
   * webhook aberto ativaria a assinatura de quem quisesse.
   */
  ASAAS_WEBHOOK_TOKEN: z.string().min(1).optional(),
  /** Dias de mensalidade em atraso antes de o estabelecimento ficar só em leitura. */
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).default(7),

  // ---- MOD-IDENT (fatia 7 da consolidação) ----

  /** Duração do trial (questão 3 do PRD §11; assumido 14 dias). */
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  /** AC-03 de MOD-IDENT-01: 5 tentativas antes de PROVISIONING_FAILED. */
  PROVISIONING_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /**
   * `PROVISIONING_RETRY_INTERVAL_MS` **não** veio junto, e a ausência é deliberada: ela
   * era do `setInterval` que o `@petshop/job-scheduler` substituiu, e já não era lida
   * por ninguém já quando isto era serviço à parte. A cadência mora na expressão cron de
   * `worker/identity-jobs.ts`; trazê-la daria a impressão de que dá para ajustar o
   * intervalo pelo ambiente, e não dá.
   */

  /**
   * Base pública do frontend, para montar o link do convite (MOD-IDENT-06).
   *
   * **Não é o `APP_DOMAIN`.** Aquele é o domínio nu, de que o Portal deriva o host de
   * cada tenant para conferir o `authorizedParties`; este é a URL completa, com
   * esquema, que entra num e-mail que uma pessoa vai clicar. Eram duas variáveis nos
   * dois serviços e continuam sendo duas.
   */
  APP_URL: z.string().url().default('http://localhost:3002'),
  /** AC-01 de MOD-IDENT-06: o convite vale 7 dias. */
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // ---- MOD-SEC (Fase 7) ----

  /**
   * MOD-SEC-03 — dias de carência para o administrador ligar o segundo fator.
   *
   * Sete é uma semana de trabalho: quem abre o Admin em qualquer dia útil vê o aviso
   * antes de ser barrado. O valor entra na coluna `mfa_grace_until` no momento em que o
   * papel é atribuído, então mudá-lo aqui **não** move prazo já concedido.
   */
  MFA_GRACE_DAYS: z.coerce.number().int().min(0).default(7),

  /** MOD-SEC-08 — retenção da trilha e dos eventos de segurança. */
  AUDIT_RETENTION_MONTHS: z.coerce.number().int().positive().default(24),
  /** Linhas por lote do expurgo. Um DELETE único sobre dois anos segura o lock. */
  AUDIT_RETENTION_BATCH: z.coerce.number().int().positive().default(5_000),
  /** Teto de tempo por execução do expurgo. O que sobrar fica para amanhã. */
  AUDIT_RETENTION_MAX_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),

  // ---- MOD-ADMIN ----

  /**
   * O primeiro administrador de plataforma (AC-06 de MOD-ADMIN-01).
   *
   * **Opcional de propósito, e sem valor padrão.** Sem ela a tabela nasce vazia e
   * `/platform/v1` fica inalcançável até alguém semear por `psql` — que é o estado correto
   * em produção, não um erro: semear pelo banco deixa rastro no acesso ao banco, que é
   * auditado por fora do produto.
   *
   * Só vale quando **não há nenhum** administrador ativo; depois disso a concessão passa a
   * ser pela rota, com trilha. Trocar o valor não promove ninguém.
   */
  PLATFORM_ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),

  /**
   * MOD-ADMIN-02 — teto do prazo que o estabelecimento pode conceder ao suporte.
   *
   * **Teto, e não valor.** O petshop escolhe quantas horas quer dar; o servidor recusa
   * acima disto. Sem teto, um grant de mil horas seria acesso permanente com outro nome —
   * e a decisão de quanto é demais não pode ser de quem está pedindo o acesso.
   *
   * Setenta e duas horas cobrem o chamado que atravessa um fim de semana, que é o caso
   * limite real do suporte.
   */
  SUPPORT_GRANT_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(72),

  /**
   * MOD-ADMIN-06 — para quem vai o alarme operacional.
   *
   * Lista separada por vírgula, e **opcional**: sem ela o destino são os administradores
   * de plataforma ativos, que é a resposta da questão em aberto nº 3 do PRD que faz a
   * lista andar junto com a equipe, sem deploy. A variável continua existindo para o caso
   * em que o alarme precisa ir a um plantão que não administra o produto.
   */
  PLATFORM_ALERT_EMAILS: z.string().optional(),

  /**
   * MOD-SEC-09 — teto do balde de `/internal/`.
   *
   * Mais folgado que o do Admin porque provedor legítimo entrega em rajada: a Evolution
   * empurra um QR novo a cada ~45s durante o pareamento, e o Resend agrupa retornos de
   * entrega. Estreitá-lo até o teto do Admin transformaria um pareamento normal em 429.
   */
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),

  /**
   * MOD-AI — a chave do provedor do modelo.
   *
   * **Opcional, e a ausência é um estado legítimo**: sem ela o agente se comporta como
   * desligado e toda conversa vai para a recepção, que é exatamente o AC-02 de
   * MOD-AI-07. Exigi-la na subida deixaria o processo inteiro de pé só quando alguém
   * quisesse ligar o atendimento automático.
   *
   * A tela de configuração diz quando ela falta — a alternativa seria o petshop ligar o
   * agente, ver o interruptor aceso e continuar sem resposta automática nenhuma.
   */
  ANTHROPIC_API_KEY: z.string().optional(),

  /**
   * MOD-AI — qual provedor atende o agente.
   *
   * `anthropic` é o alvo de produção. `gemini` existe para **desenvolvimento**: o free
   * tier do Google AI Studio deixa exercitar o agente ponta a ponta — tools, propostas,
   * confirmação — sem conta paga. Os dois implementam a mesma `ModelPort`, então nada
   * acima da porta sabe qual está atendendo.
   *
   * A escolha é do processo, e não do estabelecimento: é decisão de quem opera a
   * instalação, não de quem usa o produto. Um seletor por tenant faria dois petshops do
   * mesmo servidor receberem qualidade de atendimento diferente sem que ninguém tivesse
   * pedido isso.
   */
  AI_PROVIDER: z.enum(['anthropic', 'gemini']).default('anthropic'),

  /**
   * A chave do Google AI Studio (https://aistudio.google.com/apikey).
   *
   * Opcional pelo mesmo motivo da chave da Anthropic: sem ela, com `AI_PROVIDER=gemini`,
   * o agente se comporta como desligado em vez de derrubar a subida.
   */
  GEMINI_API_KEY: z.string().optional(),

  /**
   * O free tier tem cota por minuto, e ela é o que decide este padrão — não a qualidade.
   * Trocar por um modelo maior faz o segundo cliente do dia levar 429, que o runner lê
   * como provedor fora do ar e manda a conversa para a recepção.
   */
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
})

export type Env = ReturnType<typeof loadEnv>

export function listFromEnv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
