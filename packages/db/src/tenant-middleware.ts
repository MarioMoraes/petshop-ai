import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * MOD-IDENT-07 — contexto de tenant por requisição.
 *
 * O caminho deste arquivo é o que o PRD nomeia (`packages/db/tenant-middleware.ts`).
 *
 * Duas camadas, sem confiar em nenhuma delas isoladamente:
 *
 *   1. Banco: `withTenant()` roda `set_config('app.tenant_id', $1, true)` como
 *      primeira instrução da transação. As políticas RLS filtram a partir daí.
 *      `set_config(..., true)` é a forma parametrizável — e portanto imune a
 *      injeção — do `SET LOCAL`; o `true` final é o que a torna local à transação,
 *      de modo que o valor não vaza para a próxima requisição que reusar a mesma
 *      conexão do pool.
 *
 *   2. Aplicação: a extensão do Prisma (`src/client.ts`) recusa qualquer operação
 *      em tabela com RLS fora de um `withTenant()`. O banco já devolveria vazio,
 *      mas falhar alto revela o bug em vez de escondê-lo num resultado vazio.
 */

export interface TenantContext {
  tenantId: string
  /** Usuário autenticado, quando houver. Usado por auditoria e eventos de segurança. */
  userId?: string
}

const storage = new AsyncLocalStorage<TenantContext>()

/** Marca uma execução como deliberadamente fora de escopo de tenant. */
const PLATFORM_SCOPE: TenantContext = { tenantId: '__platform__' }

export function getTenantContext(): TenantContext | undefined {
  const context = storage.getStore()
  if (!context || context === PLATFORM_SCOPE) return undefined
  return context
}

export function getTenantId(): string | undefined {
  return getTenantContext()?.tenantId
}

/** Igual a `getTenantId()`, mas lança em vez de devolver `undefined`. */
export function requireTenantId(): string {
  const tenantId = getTenantId()
  if (!tenantId) {
    throw new TenantContextMissingError('Nenhum contexto de tenant ativo')
  }
  return tenantId
}

export function isPlatformScope(): boolean {
  return storage.getStore() === PLATFORM_SCOPE
}

export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING'
  constructor(message: string) {
    super(message)
    this.name = 'TenantContextMissingError'
  }
}

/** Roda `fn` com o contexto de tenant ativo, sem abrir transação. */
export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn)
}

/**
 * Roda `fn` explicitamente fora de escopo de tenant, liberando a guarda da
 * extensão do Prisma. Use apenas para operações de plataforma conscientes —
 * resolução de slug, bootstrap de sessão, jobs cross-tenant — e sempre com o
 * cliente de manutenção. O RLS continua valendo para o cliente da aplicação.
 */
export function runInPlatformScope<T>(fn: () => T): T {
  return storage.run(PLATFORM_SCOPE, fn)
}

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function assertValidTenantId(tenantId: string): void {
  if (!UUID_REGEX.test(tenantId)) {
    throw new TenantContextMissingError(`tenant_id inválido: ${tenantId}`)
  }
}
