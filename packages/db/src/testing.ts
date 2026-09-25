import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '#prisma-client'
export type { PrismaClient } from '#prisma-client'
import { seedCatalog } from './seed-catalog.js'
import { seedRbac } from './seed-rbac.js'

/**
 * Suporte de testes compartilhado entre os pacotes.
 *
 * Preparar o banco de testes é a mesma coisa em `@petshop/db` e nos serviços — e
 * precisa aplicar as migrations de verdade, RLS incluído, porque é justamente o
 * comportamento do banco que está sob teste.
 *
 * Só para ambiente de teste: nunca importar de código de produção.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface TestDatabaseUrls {
  appUrl: string
  migrationUrl: string
  maintenanceUrl: string
  databaseName: string
}

/** Troca o nome do banco na URL, preservando credenciais e query string. */
function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

/**
 * Cada pacote roda contra o próprio banco.
 *
 * O turbo executa as suítes dos pacotes em paralelo, e todas truncam as tabelas
 * entre os testes — compartilhar um banco só faria uma suíte apagar o cenário da
 * outra, com deadlock no meio. `TEST_DATABASE_NAME` isola cada uma; o banco é criado
 * sob demanda no `prepareTestDatabase`.
 */
export function readTestDatabaseUrls(): TestDatabaseUrls {
  const appUrl = process.env.TEST_DATABASE_URL
  const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL
  const maintenanceUrl = process.env.TEST_DATABASE_MAINTENANCE_URL
  if (!appUrl || !migrationUrl || !maintenanceUrl) {
    throw new Error(
      'TEST_DATABASE_URL, TEST_DATABASE_MIGRATION_URL e TEST_DATABASE_MAINTENANCE_URL são obrigatórias — veja .env.example',
    )
  }

  const databaseName = process.env.TEST_DATABASE_NAME ?? new URL(appUrl).pathname.slice(1)
  return {
    appUrl: withDatabaseName(appUrl, databaseName),
    migrationUrl: withDatabaseName(migrationUrl, databaseName),
    maintenanceUrl: withDatabaseName(maintenanceUrl, databaseName),
    databaseName,
  }
}

/**
 * Aponta as variáveis do processo para o banco de testes. Precisa rodar **antes** do
 * primeiro `getPrisma()`: os clientes leem a env na criação e a guardam.
 */
export function useTestDatabase(): TestDatabaseUrls {
  const urls = readTestDatabaseUrls()
  process.env.DATABASE_URL = urls.appUrl
  process.env.DATABASE_MIGRATION_URL = urls.migrationUrl
  process.env.DATABASE_MAINTENANCE_URL = urls.maintenanceUrl
  return urls
}

/** Cria o banco de testes deste pacote, se ainda não existir. */
async function ensureDatabaseExists(migrationUrl: string, databaseName: string): Promise<void> {
  // A criação precisa acontecer conectado a outro banco: `CREATE DATABASE` não roda
  // dentro do banco que está sendo criado.
  const admin = new PrismaClient({ datasourceUrl: withDatabaseName(migrationUrl, 'postgres') })
  try {
    const existing = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) AS count FROM pg_database WHERE datname = $1',
      databaseName,
    )
    if (Number(existing[0]?.count ?? 0) === 0) {
      // Sem parâmetro: `CREATE DATABASE` não aceita bind. O nome vem de env do
      // próprio repositório, não de entrada de usuário.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName.replace(/"/g, '')}"`)
    }
  } finally {
    await admin.$disconnect()
  }
}

/** Aplica as migrations e semeia o RBAC. Chamada uma vez, do `globalSetup`. */
export async function prepareTestDatabase(): Promise<void> {
  const { migrationUrl, databaseName } = readTestDatabaseUrls()
  await ensureDatabaseExists(migrationUrl, databaseName)

  execFileSync(resolve(packageRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: migrationUrl, DATABASE_MIGRATION_URL: migrationUrl },
    stdio: 'pipe',
  })

  const prisma = new PrismaClient({ datasourceUrl: migrationUrl })
  try {
    await seedRbac(prisma)
    // O catálogo global (MOD-PET-03) é seed, não cenário: `truncateBusinessTables`
    // não o apaga, porque sem espécie e porte nenhum pet pode ser cadastrado.
    await seedCatalog(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

/** Cliente superusuário: monta e limpa cenário sem esbarrar em RLS nem no trigger. */
export function createOwnerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: readTestDatabaseUrls().migrationUrl })
}

/**
 * Cliente `app_user` **sem** a extensão de guarda, para observar o comportamento do
 * banco puro — o retorno vazio que o AC-03 de MOD-IDENT-07 descreve.
 */
export function createRawAppClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: readTestDatabaseUrls().appUrl })
}

const BUSINESS_TABLES = [
  // MOD-CRM — na frente de tudo: `messages` referencia tutor e pet, e
  // `message_events` referencia a mensagem.
  'message_events',
  'messages',
  'message_templates',
  'messaging_settings',
  'messaging_suppressions',
  'automations',
  // MOD-CAIXA — o movimento aponta para a sessão, e a venda também.
  'cash_movements',
  // MOD-ESTOQUE — o item aponta para a venda e o produto, o movimento para o lote, e o
  // lote para o produto.
  'product_sale_items',
  'product_sales',
  'stock_movements',
  'stock_lots',
  'products',
  'inventory_settings',
  'cash_sessions',
  // MOD-LEDGER-08 — o recibo aponta para o pagamento, então vem antes dele.
  'receipts',
  // MOD-DOC-04 — antes de `documents`, `attendances`, `pets` e `professionals`, que a
  // prescrição referencia.
  'prescriptions',
  'documents',
  'document_counters',
  // MOD-LEDGER — na frente de tudo: referencia tutores, pets e serviços.
  // A ordem interna também importa: `package_credit_usages` e `payment_allocations`
  // apontam para lançamentos e pagamentos, que apontam para a conta.
  'ledger_idempotency_keys',
  'package_credit_usages',
  'package_purchases',
  'service_packages',
  'payment_allocations',
  'payments',
  'ledger_entries',
  'ledger_accounts',
  'billing_settings',
  // MOD-AGENDA — na frente das tabelas de pet e tutor, que elas referenciam.
  'appointment_status_log',
  'appointment_items',
  'appointments',
  'calendar_blocks',
  'professional_schedules',
  'professional_services',
  'professionals',
  'service_pricing',
  'services',
  'allergies',
  'temperaments',
  'medical_alerts',
  'pet_photos',
  'breed_visibility',
  'pet_transfer_log',
  'pet_weights',
  'pet_tutors',
  'pets',
  'tutor_merge_log',
  'tutor_consents',
  'tutor_tag_assignments',
  'tutor_tags',
  'tutor_addresses',
  'tutors',
  'audit_logs',
  'security_events',
  'data_keys',
  'tenant_role_overrides',
  'invitations',
  'memberships',
  'tenant_settings',
  'tenants',
  'users',
  // Plataforma, sem tenant: não referenciam nada e por isso vêm por último.
  'job_runs',
  'job_leases',
  // MOD-IDENT-03: a idempotência do webhook é por `svix-id`, e um id que sobrevive ao
  // cenário faz a segunda suíte receber "evento repetido" no primeiro POST.
  'webhook_events',
]

/**
 * Limpa o cenário entre testes. `TRUNCATE` não dispara o trigger `FOR EACH ROW` de
 * `audit_logs`, e é por isso a única forma de esvaziar a trilha append-only.
 * `roles`, `permissions`, `role_permissions` e o catálogo global de domínio
 * (`species`, `breeds`, `sizes`, `coats`) ficam de pé — são o seed.
 */
export async function truncateBusinessTables(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${BUSINESS_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  )
  // As raças criadas por tenant (MOD-PET-03) são cenário, não seed — mas moram na
  // mesma tabela do catálogo global, que precisa sobreviver. Daí o DELETE seletivo
  // em vez de mais um TRUNCATE.
  await prisma.$executeRawUnsafe(`DELETE FROM breeds WHERE tenant_id IS NOT NULL`)
}
