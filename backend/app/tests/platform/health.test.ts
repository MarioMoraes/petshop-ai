import type { JobHealth } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callPlatform,
  closeHarness,
  givenPlatformAdmin,
  givenUser,
  ownerPrisma,
  resetDatabase,
  type PlatformUser,
} from './fixtures.js'

/** MOD-ADMIN-04 — a saúde da plataforma. */

let admin: PlatformUser

/** Um job qualquer da grade real: o painel só fala do que o processo agenda. */
const JOB = 'messaging.dispatch'

beforeEach(async () => {
  await resetDatabase()
  await ownerPrisma.$executeRaw`TRUNCATE job_runs, job_leases`
  admin = await givenPlatformAdmin('Ana da Plataforma')
})

afterAll(closeHarness)

async function health() {
  const response = await callPlatform({ url: '/platform/v1/health', user: admin })
  expect(response.statusCode).toBe(200)
  return response.json()
}

function jobNamed(body: { jobs: JobHealth[] }, name: string): JobHealth | undefined {
  return body.jobs.find((job) => job.name === name)
}

async function recordRun(input: {
  name: string
  startedAt: Date
  status: 'OK' | 'FAILED' | 'TIMEOUT'
  error?: string
}): Promise<void> {
  await ownerPrisma.$executeRaw`
    INSERT INTO job_runs (name, started_at, finished_at, status, error)
    VALUES (
      ${input.name},
      ${input.startedAt},
      ${new Date(input.startedAt.getTime() + 1_200)},
      ${input.status}::"JobStatus",
      ${input.error ?? null}
    )
  `
}

describe('MOD-ADMIN-04 — saúde da plataforma', () => {
  it('AC-01: dependências, grade de jobs e profundidade da fila de mensagens', async () => {
    const body = await health()

    const nomes = body.dependencies.map((linha: { name: string }) => linha.name)
    expect(nomes).toEqual(['postgres', 'redis', 'rabbitmq', 'gotenberg'])

    const postgres = body.dependencies[0]
    expect(postgres).toMatchObject({ state: 'UP', error: null })
    expect(postgres.latencyMs).toBeGreaterThanOrEqual(0)

    expect(body.jobs.length).toBeGreaterThan(0)
    expect(jobNamed(body, JOB)).toMatchObject({ state: 'NEVER_RUN', lastRunAt: null })

    // A profundidade é sempre das cinco filas, mesmo zeradas: uma linha que some no dia
    // bom faz o painel parecer quebrado.
    expect(body.messages.map((linha: { status: string }) => linha.status)).toEqual([
      'QUEUED',
      'SCHEDULED',
      'SENDING',
      'FAILED',
      'DEAD',
    ])
  })

  /**
   * AC-02 — o painel não cai junto com o que ele observa.
   *
   * Neste harness Redis e broker sobem **desligados**, e é justamente o caso que a
   * distinção `DISABLED` existe para cobrir: nem verde mentiroso, nem vermelho que treina
   * a equipe a ignorar a cor. As demais seções vêm preenchidas do mesmo jeito.
   */
  it('AC-02: dependência desligada não derruba a resposta nem vira falha', async () => {
    const body = await health()

    const redis = body.dependencies.find((linha: { name: string }) => linha.name === 'redis')
    expect(redis).toMatchObject({ state: 'DISABLED', latencyMs: null, error: null })
    expect(body.jobs.length).toBeGreaterThan(0)
  })

  it('a próxima passada prevista sai da expressão cron do job', async () => {
    const body = await health()
    const job = jobNamed(body, JOB)

    expect(job?.schedule).toMatch(/^[\d*\/ ,-]+$/)
    expect(new Date(job?.nextRunAt as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('última execução com falha marca o job como FAILING', async () => {
    await recordRun({ name: JOB, startedAt: new Date(Date.now() - 60_000), status: 'OK' })
    await recordRun({
      name: JOB,
      startedAt: new Date(Date.now() - 30_000),
      status: 'FAILED',
      error: 'conexão recusada',
    })

    const body = await health()
    expect(jobNamed(body, JOB)).toMatchObject({
      state: 'FAILING',
      lastStatus: 'FAILED',
      lastError: 'conexão recusada',
      lastDurationMs: 1_200,
    })
  })

  /**
   * AC-03 — parado é medido em múltiplos do cron.
   *
   * `messaging.dispatch` roda de minuto em minuto, então vinte minutos sem sucesso são
   * vinte intervalos. O mesmo painel não pode chamar de parado o job semanal que rodou
   * ontem, e é isso que o múltiplo garante.
   */
  it('AC-03: sucesso mais antigo que 3× o intervalo vira STALE', async () => {
    await recordRun({ name: JOB, startedAt: new Date(Date.now() - 20 * 60_000), status: 'OK' })

    const body = await health()
    expect(jobNamed(body, JOB)?.state).toBe('STALE')
  })

  it('job que rodou agora fica OK', async () => {
    await recordRun({ name: JOB, startedAt: new Date(Date.now() - 10_000), status: 'OK' })

    const body = await health()
    expect(jobNamed(body, JOB)?.state).toBe('OK')
  })

  /**
   * AC-04 — o lease preso.
   *
   * `lease_until` no passado **sem** execução iniciada depois de o lease ser tomado: é a
   * marca da réplica que morreu no meio do job, e este é o único lugar onde ela aparece.
   */
  it('AC-04: lease vencido sem execução depois aparece com o holder', async () => {
    const leasedAt = new Date(Date.now() - 30 * 60_000)
    await ownerPrisma.$executeRaw`
      INSERT INTO job_leases (name, holder, leased_at, lease_until)
      VALUES (${JOB}, ${'petshop-app@replica-2#abc'}, ${leasedAt}, ${new Date(Date.now() - 20 * 60_000)})
    `

    const body = await health()
    expect(jobNamed(body, JOB)?.stuckLease).toMatchObject({
      holder: 'petshop-app@replica-2#abc',
    })
  })

  it('lease vencido com execução depois é funcionamento normal', async () => {
    const leasedAt = new Date(Date.now() - 30 * 60_000)
    await ownerPrisma.$executeRaw`
      INSERT INTO job_leases (name, holder, leased_at, lease_until)
      VALUES (${JOB}, ${'petshop-app@replica-2#abc'}, ${leasedAt}, ${new Date(Date.now() - 29 * 60_000)})
    `
    await recordRun({ name: JOB, startedAt: new Date(Date.now() - 29 * 60_000), status: 'OK' })

    const body = await health()
    expect(jobNamed(body, JOB)?.stuckLease).toBeNull()
  })

  it('quem não é da plataforma recebe 404', async () => {
    const estranho = await givenUser('Dono de Petshop')

    const response = await callPlatform({ url: '/platform/v1/health', user: estranho })
    expect(response.statusCode).toBe(404)
  })
})
