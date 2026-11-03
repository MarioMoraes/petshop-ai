import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeHarness, ownerPrisma, resetDatabase } from './fixtures.js'

/** A retenção de `job_runs`: trinta dias, menos as duas linhas que a saúde lê. */

const { pruneJobRuns } = await import('../../src/modules/platform/job-runs-retention.js')

const DIA = 86_400_000

beforeEach(async () => {
  await resetDatabase()
  await ownerPrisma.$executeRaw`TRUNCATE job_runs`
})

afterAll(closeHarness)

async function run(name: string, diasAtras: number, status: 'OK' | 'FAILED' = 'OK') {
  const startedAt = new Date(Date.now() - diasAtras * DIA)
  await ownerPrisma.$executeRaw`
    INSERT INTO job_runs (name, started_at, finished_at, status)
    VALUES (${name}, ${startedAt}, ${startedAt}, ${status}::"JobStatus")
  `
}

async function restantes(name: string): Promise<number[]> {
  const rows = await ownerPrisma.$queryRaw<{ started_at: Date }[]>`
    SELECT started_at FROM job_runs WHERE name = ${name} ORDER BY started_at DESC
  `
  return rows.map((row) => Math.round((Date.now() - row.started_at.getTime()) / DIA))
}

describe('retenção de job_runs', () => {
  it('apaga o que passou de trinta dias e mantém o recente', async () => {
    await run('a', 1)
    await run('a', 29)
    await run('a', 31)
    await run('a', 90)

    const { removed } = await pruneJobRuns()

    expect(removed).toBe(2)
    expect(await restantes('a')).toEqual([1, 29])
  })

  it('o job parado há muito tempo mantém a última execução e a última bem-sucedida', async () => {
    await run('parado', 40, 'FAILED')
    await run('parado', 50, 'FAILED')
    await run('parado', 60, 'OK')
    await run('parado', 70, 'OK')

    const { removed } = await pruneJobRuns()

    // Sem estas duas, a saúde diria "nunca rodou" de um job que está falhando há 40 dias.
    expect(removed).toBe(2)
    expect(await restantes('parado')).toEqual([40, 60])
  })
})
