import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * O lease e o agendador contra o banco de verdade.
 *
 * O que está sob teste é a exclusão entre réplicas — e ela mora numa instrução SQL, não
 * no TypeScript. Testar contra um dublê provaria só que o dublê funciona.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
process.env.TEST_DATABASE_NAME = 'petshop_test_job_scheduler'
process.env.NODE_ENV = 'test'

const { useTestDatabase, createOwnerClient } = await import('@petshop/db/testing')
useTestDatabase()

const { getMaintenancePrisma, disconnectPrisma } = await import('@petshop/db')
const { claimLease, recordRun, releaseLease } = await import('../src/lease.js')
const { createJobScheduler } = await import('../src/runner.js')

/** O que está sob teste roda como `app_maintenance` — é o papel real dos jobs. */
const prisma = getMaintenancePrisma()
/**
 * A limpeza roda como dono: `TRUNCATE` exige propriedade da tabela, e o
 * `ALTER DEFAULT PRIVILEGES` da migration de RLS concede só SELECT/INSERT/UPDATE/DELETE.
 * Que `app_maintenance` **não** possa truncar é o comportamento certo — o job escreve
 * histórico, não apaga o dos outros.
 */
const owner = createOwnerClient()

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}
const recordMetric = vi.fn()

beforeEach(async () => {
  await owner.$executeRawUnsafe('TRUNCATE TABLE job_runs, job_leases')
  vi.clearAllMocks()
})

afterAll(async () => {
  await Promise.all([owner.$disconnect(), disconnectPrisma()])
})

describe('claimLease — exclusão entre réplicas', () => {
  it('a primeira réplica leva; a segunda desiste e sabe de quem é', async () => {
    const primeira = await claimLease('teste.job', 'replica-a', 60_000)
    const segunda = await claimLease('teste.job', 'replica-b', 60_000)

    expect(primeira.acquired).toBe(true)
    expect(segunda.acquired).toBe(false)
    expect(segunda.heldBy).toBe('replica-a')
  })

  it('lease vencido é reivindicável — é o que cobre a morte do processo', async () => {
    // TTL negativo simula o processo que caiu no meio e nunca liberou.
    await claimLease('teste.job', 'replica-morta', -1_000)

    const nova = await claimLease('teste.job', 'replica-viva', 60_000)
    expect(nova.acquired).toBe(true)
  })

  it('liberar devolve o lease para a próxima', async () => {
    await claimLease('teste.job', 'replica-a', 60_000)
    await releaseLease('teste.job', 'replica-a')

    expect((await claimLease('teste.job', 'replica-b', 60_000)).acquired).toBe(true)
  })

  it('quem não é dono não consegue liberar o lease de outro', async () => {
    await claimLease('teste.job', 'replica-a', 60_000)
    // A réplica atrasada tenta liberar depois de o TTL virar; não pode derrubar o dono.
    await releaseLease('teste.job', 'replica-atrasada')

    expect((await claimLease('teste.job', 'replica-c', 60_000)).acquired).toBe(false)
  })

  it('leases de jobs diferentes não se atrapalham', async () => {
    expect((await claimLease('job.um', 'replica-a', 60_000)).acquired).toBe(true)
    expect((await claimLease('job.dois', 'replica-a', 60_000)).acquired).toBe(true)
  })

  it('dez tentativas simultâneas produzem exatamente um vencedor', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        claimLease('teste.corrida', `replica-${index}`, 60_000),
      ),
    )

    expect(results.filter((result) => result.acquired)).toHaveLength(1)
  })
})

describe('recordRun — o histórico', () => {
  it('grava o que o job devolveu', async () => {
    await recordRun({
      name: 'teste.job',
      startedAt: new Date(),
      finishedAt: new Date(),
      status: 'OK',
      result: { marked: 3 },
    })

    const rows = await prisma.$queryRawUnsafe<{ name: string; status: string; result: unknown }[]>(
      'SELECT name, status::text, result FROM job_runs',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'teste.job', status: 'OK', result: { marked: 3 } })
  })

  it('guarda a mensagem quando falha', async () => {
    await recordRun({
      name: 'teste.job',
      startedAt: new Date(),
      finishedAt: new Date(),
      status: 'FAILED',
      error: 'banco fora do ar',
    })

    const rows = await prisma.$queryRawUnsafe<{ error: string }[]>('SELECT error FROM job_runs')
    expect(rows[0]?.error).toBe('banco fora do ar')
  })
})

describe('createJobScheduler', () => {
  function scheduler(jobs: Parameters<typeof createJobScheduler>[0]['jobs']) {
    return createJobScheduler({
      service: 'teste',
      logger,
      recordMetric,
      isDisabled: () => false,
      jobs,
    })
  }

  it('recusa expressão inválida na criação, não de madrugada', () => {
    expect(() =>
      scheduler([{ name: 'x', schedule: 'todo dia', run: async () => undefined }]),
    ).toThrow(/cron inválida/)
  })

  it('`runJobNow` executa e registra a passagem', async () => {
    const run = vi.fn().mockResolvedValue({ expired: 2 })
    const sched = scheduler([{ name: 'teste.now', schedule: '0 3 * * *', run }])

    await expect(sched.runJobNow('teste.now')).resolves.toEqual({ expired: 2 })
    expect(run).toHaveBeenCalledOnce()

    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
      "SELECT status::text FROM job_runs WHERE name = 'teste.now'",
    )
    expect(rows[0]?.status).toBe('OK')
  })

  it('job que lança vira FAILED no histórico e conta a métrica', async () => {
    const sched = scheduler([
      {
        name: 'teste.falha',
        schedule: '0 3 * * *',
        run: async () => {
          throw new Error('o banco recusou')
        },
      },
    ])

    await expect(sched.runJobNow('teste.falha')).rejects.toThrow('o banco recusou')

    const rows = await prisma.$queryRawUnsafe<{ status: string; error: string }[]>(
      "SELECT status::text, error FROM job_runs WHERE name = 'teste.falha'",
    )
    expect(rows[0]).toMatchObject({ status: 'FAILED', error: 'o banco recusou' })
    expect(recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'job_failure_total' }),
    )
  })

  it('job que passa do teto é interrompido e marcado TIMEOUT', async () => {
    const sched = scheduler([
      {
        name: 'teste.lento',
        schedule: '0 3 * * *',
        timeoutMs: 50,
        run: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
      },
    ])

    await expect(sched.runJobNow('teste.lento')).rejects.toThrow(/interrompido/)

    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
      "SELECT status::text FROM job_runs WHERE name = 'teste.lento'",
    )
    expect(rows[0]?.status).toBe('TIMEOUT')
  })

  it('job desconhecido é erro de quem chamou, não silêncio', async () => {
    const sched = scheduler([{ name: 'teste.existe', schedule: '0 3 * * *', run: async () => 1 }])
    await expect(sched.runJobNow('teste.nao-existe')).rejects.toThrow(/desconhecido/)
  })

  it('desabilitado, `startJobs` não arma nada', async () => {
    const run = vi.fn()
    const sched = createJobScheduler({
      service: 'teste',
      logger,
      recordMetric,
      isDisabled: () => true,
      jobs: [{ name: 'teste.off', schedule: '* * * * *', run }],
    })

    sched.startJobs()
    await sched.stopJobs()
    expect(run).not.toHaveBeenCalled()
  })

  it('`stopJobs` espera o ciclo em curso — o `process.exit` vem logo depois', async () => {
    let finished = false
    const sched = scheduler([
      {
        name: 'teste.espera',
        schedule: '0 3 * * *',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          finished = true
          return { ok: true }
        },
      },
    ])

    sched.startJobs()
    const running = sched.runJobNow('teste.espera')
    await sched.stopJobs()
    await running

    expect(finished).toBe(true)
  })
})
