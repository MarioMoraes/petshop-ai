import { randomBytes } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  callPlatform,
  closeHarness,
  givenPlatformAdmin,
  givenUser,
  ownerPrisma,
  resetDatabase,
  seedTenant,
  type PlatformUser,
} from './fixtures.js'

/** MOD-ADMIN-05 — o coletor de métricas. */

const { recordMetric, drainMetrics } = await import('../../src/shared/logger.js')
const { rollUpMetrics, compactMetrics } = await import('../../src/modules/platform/metrics.js')

let admin: PlatformUser
/** Nome próprio por teste: a suíte inteira emite métricas, e elas caem no mesmo balde. */
let metrica: string

beforeEach(async () => {
  await resetDatabase()
  // O acumulador é do processo e sobrevive entre testes; drenar aqui evita que a amostra
  // de um caso apareça na asserção do seguinte.
  drainMetrics()
  admin = await givenPlatformAdmin('Ana da Plataforma')
  metrica = `teste_${randomBytes(4).toString('hex')}`
})

afterAll(closeHarness)

async function linhas(nome: string) {
  return ownerPrisma.platformMetric.findMany({
    where: { metric: nome },
    orderBy: { bucket: 'asc' },
  })
}

describe('MOD-ADMIN-05 — o roll-up', () => {
  it('AC-01: as amostras da janela viram uma linha por métrica, tenant e balde', async () => {
    const tenant = await seedTenant('petshop-metrica')

    recordMetric({ metric: metrica, tenantId: tenant.tenantId, value: 10, unit: 'count' })
    recordMetric({ metric: metrica, tenantId: tenant.tenantId, value: 30, unit: 'count' })
    recordMetric({ metric: metrica, tenantId: tenant.tenantId, value: 20, unit: 'count' })

    await rollUpMetrics()

    const série = await linhas(metrica)
    expect(série).toHaveLength(1)
    expect(série[0]).toMatchObject({
      tenantId: tenant.tenantId,
      resolution: 'FIVE_MIN',
      count: 3,
    })
    expect(Number(série[0]?.sum)).toBe(60)
    expect(Number(série[0]?.min)).toBe(10)
    expect(Number(série[0]?.max)).toBe(30)
    // Com três amostras, o percentil 95 é a maior delas.
    expect(Number(série[0]?.p95)).toBe(30)
  })

  it('AC-03: métrica sem tenant nasce com `tenant_id` nulo, e isso é informação', async () => {
    recordMetric({ metric: metrica, value: 1, unit: 'count' })
    await rollUpMetrics()

    const série = await linhas(metrica)
    expect(série).toHaveLength(1)
    expect(série[0]?.tenantId).toBeNull()
  })

  /**
   * RN-09 — duas réplicas drenam acumuladores diferentes do mesmo balde.
   *
   * O `ON CONFLICT` precisa **somar**. Um `UPDATE SET sum =` faria a segunda drenagem
   * apagar a primeira, e o gráfico mostraria metade do movimento sem erro nenhum no log.
   */
  it('RN-09: a segunda drenagem do mesmo balde soma, não sobrescreve', async () => {
    recordMetric({ metric: metrica, value: 4, unit: 'count' })
    await rollUpMetrics()

    recordMetric({ metric: metrica, value: 6, unit: 'count' })
    await rollUpMetrics()

    const série = await linhas(metrica)
    expect(série).toHaveLength(1)
    expect(Number(série[0]?.sum)).toBe(10)
    expect(série[0]?.count).toBe(2)
  })

  it('drenar esvazia: a mesma amostra não entra duas vezes', async () => {
    recordMetric({ metric: metrica, value: 7, unit: 'count' })
    await rollUpMetrics()
    await rollUpMetrics()

    const série = await linhas(metrica)
    expect(Number(série[0]?.sum)).toBe(7)
  })

  it('sem amostra nenhuma, o job não escreve linha', async () => {
    const resultado = await rollUpMetrics()
    expect(resultado).toEqual({ keys: 0, samples: 0 })
  })
})

describe('MOD-ADMIN-05 — a consulta', () => {
  it('AC-02: devolve a série da métrica no intervalo pedido', async () => {
    const tenant = await seedTenant('petshop-serie')
    recordMetric({ metric: metrica, tenantId: tenant.tenantId, value: 5, unit: 'count' })
    await rollUpMetrics()

    const response = await callPlatform({
      url: `/platform/v1/metrics?metric=${metrica}`,
      user: admin,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ metric: metrica, bucketSize: 'FIVE_MIN', groupBy: 'total' })
    expect(body.points).toHaveLength(1)
    expect(body.points[0]).toMatchObject({ sum: 5, count: 1, tenantId: null })
  })

  it('AC-02: `groupBy=tenant` separa por estabelecimento; `total` soma', async () => {
    const um = await seedTenant('petshop-um')
    const outro = await seedTenant('petshop-dois')
    recordMetric({ metric: metrica, tenantId: um.tenantId, value: 2, unit: 'count' })
    recordMetric({ metric: metrica, tenantId: outro.tenantId, value: 3, unit: 'count' })
    await rollUpMetrics()

    const porTenant = await callPlatform({
      url: `/platform/v1/metrics?metric=${metrica}&groupBy=tenant`,
      user: admin,
    })
    expect(porTenant.json().points).toHaveLength(2)

    const total = await callPlatform({
      url: `/platform/v1/metrics?metric=${metrica}&groupBy=total`,
      user: admin,
    })
    expect(total.json().points).toHaveLength(1)
    expect(total.json().points[0].sum).toBe(5)
  })

  it('janela longa é servida em baldes maiores', async () => {
    const from = new Date(Date.now() - 5 * 86_400_000).toISOString()
    const response = await callPlatform({
      url: `/platform/v1/metrics?metric=${metrica}&from=${from}`,
      user: admin,
    })

    expect(response.json().bucketSize).toBe('HOUR')
  })

  it('janela além da retenção de cinco minutos cai na série diária', async () => {
    const from = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const response = await callPlatform({
      url: `/platform/v1/metrics?metric=${metrica}&from=${from}`,
      user: admin,
    })

    expect(response.json().bucketSize).toBe('DAY')
  })

  it('métrica ausente na consulta volta 422', async () => {
    const response = await callPlatform({ url: '/platform/v1/metrics', user: admin })
    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_ADMIN_005')
  })

  it('quem não é da plataforma recebe 404', async () => {
    const estranho = await givenUser('Dono de Petshop')
    const response = await callPlatform({
      url: `/platform/v1/metrics?metric=${metrica}`,
      user: estranho,
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('MOD-ADMIN-05 — retenção', () => {
  /** Escreve direto na tabela: o cenário precisa de baldes com semanas de idade. */
  async function semear(bucket: Date, resolution: 'FIVE_MIN' | 'DAY', valor: number) {
    await ownerPrisma.platformMetric.create({
      data: {
        metric: metrica,
        bucket,
        resolution,
        sum: valor,
        count: 1,
        min: valor,
        max: valor,
        p95: valor,
      },
    })
  }

  it('AC-04: baldes de cinco minutos com mais de 30 dias viram um balde por dia', async () => {
    const dia = new Date(Date.now() - 40 * 86_400_000)
    dia.setUTCHours(9, 0, 0, 0)
    await semear(dia, 'FIVE_MIN', 4)
    await semear(new Date(dia.getTime() + 3_600_000), 'FIVE_MIN', 6)

    const resultado = await compactMetrics()
    expect(resultado.compacted).toBe(1)
    expect(resultado.removed).toBe(2)

    const série = await linhas(metrica)
    expect(série).toHaveLength(1)
    expect(série[0]?.resolution).toBe('DAY')
    // As duas horas do mesmo dia somam, e o dia guarda o maior e o menor.
    expect(Number(série[0]?.sum)).toBe(10)
    expect(Number(série[0]?.max)).toBe(6)
  })

  it('AC-04: a série diária expira depois de treze meses', async () => {
    await semear(new Date(Date.now() - 400 * 86_400_000), 'DAY', 1)
    await semear(new Date(Date.now() - 10 * 86_400_000), 'DAY', 2)

    const resultado = await compactMetrics()
    expect(resultado.expired).toBe(1)

    const série = await linhas(metrica)
    expect(série).toHaveLength(1)
  })

  it('compactar duas vezes não duplica o dia', async () => {
    const dia = new Date(Date.now() - 40 * 86_400_000)
    dia.setUTCHours(9, 0, 0, 0)
    await semear(dia, 'FIVE_MIN', 4)

    await compactMetrics()
    await compactMetrics()

    expect(await linhas(metrica)).toHaveLength(1)
  })
})
