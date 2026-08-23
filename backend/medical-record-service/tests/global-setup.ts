import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/** Migrations (RLS, triggers e índices incluídos) e seed de RBAC e catálogo, antes de tudo. */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export default async function setup() {
  config({ path: resolve(repoRoot, '.env'), quiet: true })
  // Banco de testes próprio deste pacote: o turbo roda as suítes em paralelo.
  process.env.TEST_DATABASE_NAME = 'petshop_test_record'
  const { prepareTestDatabase } = await import('@petshop/db/testing')
  await prepareTestDatabase()
}
