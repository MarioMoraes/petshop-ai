import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/** Migrations (RLS incluído) e seed de RBAC, antes de qualquer teste subir o app. */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export default async function setup() {
  config({ path: resolve(repoRoot, '.env'), quiet: true })
// Banco de testes próprio deste pacote: o turbo roda as suítes em paralelo.
process.env.TEST_DATABASE_NAME = 'petshop_test_identity'
  const { prepareTestDatabase } = await import('@petshop/db/testing')
  await prepareTestDatabase()
}
