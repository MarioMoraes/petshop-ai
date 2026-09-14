import { z } from 'zod'

/**
 * Carregamento e validação de configuração, comum a todo processo do backend.
 *
 * Cada serviço declara **só o que é seu** (a porta, as chaves de integração, os
 * limites de negócio) e recebe pronto o núcleo que ninguém consegue rodar sem: banco,
 * Redis, segredo do contrato de serviço. Validar na subida, com o nome da variável
 * faltante, é muito melhor do que descobrir a ausência no meio de uma requisição.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

/**
 * O que todo processo precisa — inclusive o gateway, que não fala com o broker nem
 * cifra nada.
 */
export const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAINTENANCE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1),

  INTERNAL_SERVICE_SECRET: z.string().min(16),

  DISABLE_REDIS: z.coerce.boolean().default(false),
} as const

/**
 * O núcleo dos serviços de domínio: acrescenta o broker e as chaves de cifra ao
 * `baseEnvShape`. O gateway fica de fora de propósito — ele não publica evento nem
 * decifra PII, e exigir `ENCRYPTION_KEK` dele seria pedir um segredo que ele não usa.
 */
export const serviceEnvShape = {
  ...baseEnvShape,

  RABBITMQ_URL: z.string().min(1),

  ENCRYPTION_KEK: z.string().min(1),
  EMAIL_HASH_PEPPER: z.string().min(1),

  /** Desligam broker e cache em teste, onde ambos são substituídos por dublês. */
  DISABLE_EVENTS: z.coerce.boolean().default(false),
  /**
   * Desliga o agendador de jobs. A suíte o liga por `process.env`, como faz com
   * `DISABLE_EVENTS` e `DISABLE_REDIS`: um `setInterval` de um minuto rodando durante
   * os testes é intermitência garantida.
   */
  DISABLE_JOBS: z.coerce.boolean().default(false),
} as const

/**
 * Variável vazia é variável ausente.
 *
 * Não é conveniência: é o que separa a configuração que **existe** da que o
 * orquestrador inventou. `environment: { CLERK_WEBHOOK_SECRET: "${CLERK_WEBHOOK_SECRET:-}" }`
 * — a forma como os dois composes declaram toda credencial opcional — entrega a string
 * vazia ao container quando a variável não está no `.env.production`, e não a ausência.
 * Para o Zod, `''` é uma string: `z.string().min(1).optional()` **reprova**, e
 * `z.string().default(…)` aceita o vazio em vez de aplicar o padrão.
 *
 * As duas consequências foram medidas contra o schema do backend, não presumidas:
 *
 * - `PLATFORM_ADMIN_BOOTSTRAP_EMAIL`, `CLERK_WEBHOOK_SECRET`, `RESEND_API_KEY`,
 *   `MAIL_FROM` e `RESEND_WEBHOOK_SECRET` derrubam a subida do processo inteiro — e
 *   todas as cinco são opcionais justamente porque deixá-las em branco é um estado
 *   legítimo. O comentário do compose chega a dizer que vazia "é o estado normal
 *   depois do primeiro deploy".
 * - `SITE_REVALIDATE_SECRET` faz pior: aceita `''`, o padrão não entra, e os dois
 *   lados do segredo compartilhado deixam de bater sem que nada falhe alto.
 *
 * Corrigir aqui, e não em cada entrada dos composes, porque a armadilha é da forma
 * `${VAR:-}` — ela reaparece em toda variável opcional que alguém acrescentar depois.
 */
function semVazias(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const limpo: NodeJS.ProcessEnv = {}
  for (const [chave, valor] of Object.entries(source)) {
    if (valor !== '') limpo[chave] = valor
  }
  return limpo
}

export interface EnvLoader<T> {
  /**
   * Lê e valida a configuração, memoizando o resultado. O `source` existe para os
   * testes: em produção ninguém passa nada.
   */
  loadEnv: (source?: NodeJS.ProcessEnv) => T
  resetEnvCache: () => void
}

/**
 * Monta o par `loadEnv`/`resetEnvCache` de um serviço.
 *
 * O cache é por chamada de `defineEnv`, e não global, porque cada serviço tem o seu
 * módulo `env.ts` — dois serviços no mesmo processo (só acontece em teste) não
 * disputam a mesma memória.
 */
export function defineEnv<S extends z.ZodRawShape>(
  serviceName: string,
  shape: S,
): EnvLoader<z.infer<z.ZodObject<S>>> {
  const schema = z.object(shape)
  type Env = z.infer<z.ZodObject<S>>

  let cached: Env | null = null

  return {
    loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
      if (cached) return cached
      const parsed = schema.safeParse(semVazias(source))
      if (!parsed.success) {
        const missing = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n  ')
        throw new Error(`Configuração inválida do ${serviceName}:\n  ${missing}`)
      }
      cached = parsed.data as Env
      return cached
    },
    resetEnvCache(): void {
      cached = null
    },
  }
}
