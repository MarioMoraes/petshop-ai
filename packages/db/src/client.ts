import { PrismaClient } from '#prisma-client'
import type { Prisma } from '#prisma-client'
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

/**
 * Modelos com política RLS — a lista espelha as migrations que fazem
 * `ENABLE ROW LEVEL SECURITY`.
 *
 * Exportada para que `tests/rls-models-sync.test.ts` compare esta lista com o SQL
 * das migrations e com o `schema.prisma`. A sincronia era mantida só por disciplina;
 * o teste transforma o esquecimento em falha de build, e não em vazamento silencioso.
 */
export const RLS_MODELS: ReadonlySet<string> = new Set([
  'Tenant',
  'TenantSettings',
  'Membership',
  'Invitation',
  'TenantRoleOverride',
  'AuditLog',
  'SecurityEvent',
  'SupportAccessGrant',
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
  // MOD-PRONT-01/09/10: o registro do que foi feito com o animal.
  'Attendance',
  'AttendanceItem',
  'AttendanceNote',
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
  'AppointmentRecurrence',
  // MOD-LEDGER: a conta corrente do tutor. Nenhuma leitura financeira acontece sem
  // saber de que tenant — extrato é o dado mais sensível que o módulo guarda.
  'LedgerAccount',
  'LedgerEntry',
  'Payment',
  'PaymentAllocation',
  'ServicePackage',
  'PackagePurchase',
  'PackageCreditUsage',
  'BillingSettings',
  'LedgerIdempotencyKey',
  'Receipt',
  // MOD-DOC: o registro de todo documento com valor legal. `DocumentCounter` entra
  // junto — a série é por tenant, e um contador legível fora do contexto contaria
  // quantos documentos o vizinho emitiu.
  'Document',
  'DocumentCounter',
  // MOD-DOC-04: o receituário. Prescrição alheia é prontuário alheio — o conteúdo é
  // cifrado, mas quem tomou o quê já é a informação clínica.
  'Prescription',
  // MOD-DOC-06: o texto do termo é do tenant, e ler o do vizinho é ler o contrato dele
  // com os clientes dele.
  'TermVersion',
  // MOD-TAXI: o leva-e-traz. `TaxiRideStatusLog` entra junto porque carrega
  // `tenant_id` próprio — a trilha de uma corrida é tão do tenant quanto a corrida.
  'TaxiRide',
  'TaxiRideStatusLog',
  'TaxiVehicle',
  'TaxiZone',
  'TaxiSettings',
  // MOD-CRM: a fila de saída e o histórico de conversa. `MessageEvent` entra junto
  // porque carrega `tenant_id` próprio — o callback do provedor sobre uma mensagem é
  // tão do tenant quanto a mensagem.
  'Message',
  'MessageEvent',
  'MessageTemplate',
  'MessagingSettings',
  'MessagingSuppression',
  'Automation',
  // MOD-CRM fatia 3: campanhas. As três carregam `tenant_id` próprio, inclusive a de
  // execução — a alternativa seria isolá-la pela FK da campanha-mãe, o que faria a
  // política do banco depender de um JOIN e a guarda de aplicação não cobrir a tabela.
  'Campaign',
  'CampaignRun',
  'CampaignTarget',
  // A conexão de WhatsApp é do tenant como qualquer outra configuração dele. O webhook
  // do provedor chega sem contexto, mas quem resolve o tenant pelo hash do token é
  // `platform.ts`, no escopo sancionado — a gravação volta para `withTenant()`.
  'WhatsappInstance',
  // MOD-SITE: o site do estabelecimento. `SiteLead` entra apesar de a escrita nascer
  // de visitante anônimo — o tenant vem do host, é resolvido antes por
  // `platform.resolveTenantBySlug` e a gravação roda em `withTenant()` como qualquer
  // outra. Anônimo é o autor, não o dado: o lead é do petshop que o recebeu.
  'SiteSettings',
  'SitePhoto',
  'SiteLead',
  // MOD-PORTAL: pelo mesmo motivo de `SiteLead`. Quem pede o desafio é uma conta do
  // Clerk sem vínculo nenhum com o tenant, mas o tenant vem do host e é resolvido antes
  // de a linha existir — a tentativa é do petshop que a recebeu.
  'PortalLinkChallenge',
  // MOD-PORTAL-09: a troca de contato e o pedido de exclusão. Os dois nascem no Portal
  // e são lidos no Admin — a fila da equipe é a razão de o segundo existir —, e nenhum
  // dos dois tem leitura que atravesse tenant.
  'PortalContactChange',
  'DataDeletionRequest',
  // `JobLease` e `JobRun` ficam **fora** de propósito, como `User`, `Role` e
  // `Permission`: são tabelas de plataforma, sem dono de tenant. Um job varre todos os
  // tenants por definição, e exigir contexto dele seria negar o que ele é.
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
