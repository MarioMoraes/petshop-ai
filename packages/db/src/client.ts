import { PrismaClient } from '../generated/client/index.js'
import type { Prisma } from '../generated/client/index.js'
import {
  TenantContextMissingError,
  assertValidTenantId,
  getTenantId,
  isPlatformScope,
  runWithTenantContext,
  type TenantContext,
} from './tenant-middleware.js'

/**
 * Clientes Prisma do PetShop AI.
 *
 * `prisma`            — conecta como `app_user`, papel SEM BYPASSRLS. É o cliente
 *                       de toda requisição de usuário. Use sempre via `withTenant()`.
 * `maintenancePrisma` — conecta como `app_maintenance`, COM BYPASSRLS. Só para as
 *                       operações de plataforma listadas em `src/platform.ts` e para
 *                       jobs cross-tenant (AC-03 de MOD-IDENT-07).
 */

/** Modelos com política RLS — a lista espelha a migration `*_rls_policies`. */
const RLS_MODELS = new Set([
  'Tenant',
  'TenantSettings',
  'Membership',
  'Invitation',
  'TenantRoleOverride',
  'AuditLog',
  'SecurityEvent',
  'DataKey',
  'Tutor',
  'TutorAddress',
  'TutorTag',
  'TutorTagAssignment',
  'TutorConsent',
  'TutorMergeLog',
  'Pet',
  'PetTutor',
  'PetWeight',
  'PetTransferLog',
  'PetPhoto',
  'Allergy',
  'Temperament',
  'MedicalAlert',
  'BreedVisibility',
  // Catálogo de domínio: a política é mista (global legível, escrita só do
  // tenant), mas a guarda continua exigindo contexto — ler catálogo sem saber de
  // que tenant é esconde a extensão do tenant e devolve só o global, calado.
  'Species',
  'Breed',
  'Size',
  'Coat',
  // MOD-AGENDA: catálogo de serviços, quem executa e quando não dá.
  'Service',
  'ServicePricing',
  'Professional',
  'ProfessionalService',
  'ProfessionalSchedule',
  'CalendarBlock',
  'Appointment',
  'AppointmentItem',
  'AppointmentStatusLog',
])

export interface DbLogger {
  error(payload: Record<string, unknown>, message: string): void
}

const defaultLogger: DbLogger = {
  error(payload, message) {
    console.error(JSON.stringify({ level: 'error', msg: message, ...payload }))
  },
}

let logger: DbLogger = defaultLogger

/** Injeta o Pino do serviço, para que os logs saiam correlacionados por requisição. */
export function setDbLogger(next: DbLogger): void {
  logger = next
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} não configurada — veja .env.example`)
  return value
}

function createAppClient() {
  const base = new PrismaClient({
    datasourceUrl: requireEnv('DATABASE_URL'),
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })

  return base.$extends({
    name: 'rls-tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (RLS_MODELS.has(model) && !getTenantId() && !isPlatformScope()) {
            // O banco já devolveria vazio pela política. Falhar aqui transforma um
            // resultado silenciosamente vazio em um bug visível.
            logger.error(
              { code: 'TENANT_CONTEXT_MISSING', model, operation },
              'Operação em tabela com RLS fora de um contexto de tenant',
            )
            throw new TenantContextMissingError(
              `${model}.${operation} exige contexto de tenant: use withTenant() ou runInPlatformScope() com o cliente de manutenção`,
            )
          }
          return query(args)
        },
      },
    },
  })
}

export type PrismaAppClient = ReturnType<typeof createAppClient>

/**
 * Cliente dentro de uma transação com tenant ativo. É o `Omit` que o Prisma aplica
 * às transações interativas (sem `$connect`, `$transaction` aninhado etc.).
 */
export type TenantTransaction = Omit<
  PrismaAppClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>

let appClient: PrismaAppClient | null = null
let maintenanceClient: PrismaClient | null = null

export function getPrisma(): PrismaAppClient {
  appClient ??= createAppClient()
  return appClient
}

/**
 * Cliente com BYPASSRLS. Não use em código de requisição — é o cliente para o qual
 * as políticas RLS não valem.
 */
export function getMaintenancePrisma(): PrismaClient {
  maintenanceClient ??= new PrismaClient({
    datasourceUrl: requireEnv('DATABASE_MAINTENANCE_URL'),
    log: ['warn', 'error'],
  })
  return maintenanceClient
}

export interface WithTenantOptions {
  userId?: string
  /** Teto da transação interativa; o padrão cobre handlers de requisição. */
  timeoutMs?: number
  maxWaitMs?: number
  /**
   * Nível de isolamento. O padrão do Postgres (`ReadCommitted`) serve para quase
   * tudo; `Serializable` existe para o RN-13 do MOD-AGENDA, em que contar os
   * atendimentos de uma janela e inserir mais um precisa ser atômico contra
   * *phantom reads* — não há linha a travar, porque a linha em disputa é a que ainda
   * não existe.
   *
   * Quem pedir `Serializable` **precisa** tratar o erro de serialização (40001): sob
   * esse nível o banco aborta uma das transações concorrentes, e isso é
   * funcionamento normal, não falha.
   */
  isolationLevel?: Prisma.TransactionIsolationLevel
}

/**
 * Abre uma transação com `app.tenant_id` setado e roda `fn` dentro dela.
 *
 * Toda leitura e escrita de dados de negócio passa por aqui. O `set_config` é a
 * primeira instrução da transação, então nenhuma query roda sem política aplicada.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  assertValidTenantId(tenantId)

  const context: TenantContext = options.userId
    ? { tenantId, userId: options.userId }
    : { tenantId }

  return runWithTenantContext(context, () =>
    getPrisma().$transaction(
      async (tx) => {
        // Parametrizado pelo template tag: o valor nunca é concatenado no SQL.
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        return fn(tx as TenantTransaction)
      },
      {
        maxWait: options.maxWaitMs ?? 5_000,
        timeout: options.timeoutMs ?? 15_000,
        ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      },
    ),
  )
}

export async function disconnectPrisma(): Promise<void> {
  await Promise.all([appClient?.$disconnect(), maintenanceClient?.$disconnect()])
  appClient = null
  maintenanceClient = null
}
