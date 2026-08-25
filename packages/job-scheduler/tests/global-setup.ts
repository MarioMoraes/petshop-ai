import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/** O lease vive no banco: a suíte precisa das migrations aplicadas. */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export default async function setup() {
  config({ path: resolve(repoRoot, '.env'), quiet: true })
  process.env.TEST_DATABASE_NAME = 'petshop_test_job_scheduler'
  const { prepareTestDatabase } = await import('@petshop/db/testing')
  await prepareTestDatabase()
}
