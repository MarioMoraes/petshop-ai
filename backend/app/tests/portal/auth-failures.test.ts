import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  callApi,
  closeHarness,
  getApp,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * O teto de tokens recusados (`src/auth/auth-failures.ts`), que corre antes da
 * verificação. O `@fastify/rate-limit` só conta depois da autenticação, e o que ela
 * recusa nunca chegava a ele.
 *
 * O IP sai do `x-forwarded-for`, como em produção (`trustProxy`): cada teste usa o seu,
 * porque o app da suíte é um só por arquivo e o contador vive nele.
 */

const SLUG_HEADER = 'x-petshop-tenant-slug'
const TETO = 20

let tenant: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function comToken(token: string | null, ip: string, url = '/portal/v1/terms') {
  const app = await getApp()
  return app.inject({
    method: 'GET',
    url,
    headers: {
      [SLUG_HEADER]: tenant.slug,
      'x-forwarded-for': ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
}

describe('Portal — o teto de tokens recusados', () => {
  it('passado o teto, a chave leva 429 sem verificar — inclusive com token válido', async () => {
    const ip = '198.51.100.1'
    for (let i = 0; i < TETO; i += 1) {
      expect((await comToken(`inventado-${i}`, ip)).statusCode).toBe(401)
    }

    expect((await comToken('mais-um', ip)).statusCode).toBe(429)

    const tutorId = await givenTutor(tenant)
    const valido = await callApi({
      ...asTutor(tenant, tutorId),
      method: 'GET',
      url: '/portal/v1/terms',
      headers: { 'x-forwarded-for': ip },
    })
    expect(valido.statusCode).toBe(429)
    expect(valido.json().code).toBe('ERR_RATE_LIMITED')
  })

  it('o bloqueio é do par petshop×IP: outro IP continua entrando', async () => {
    for (let i = 0; i < TETO + 1; i += 1) await comToken(`inventado-${i}`, '198.51.100.2')

    const tutorId = await givenTutor(tenant)
    const outroIp = await callApi({
      ...asTutor(tenant, tutorId),
      method: 'GET',
      url: '/portal/v1/terms',
      headers: { 'x-forwarded-for': '198.51.100.3' },
    })
    expect(outroIp.statusCode).toBe(200)
  })

  it('token ausente não conta — é quem saiu da sessão, e não custa verificação', async () => {
    const ip = '198.51.100.4'
    for (let i = 0; i < TETO * 2; i += 1) {
      expect((await comToken(null, ip)).statusCode).toBe(401)
    }

    const tutorId = await givenTutor(tenant)
    const valido = await callApi({
      ...asTutor(tenant, tutorId),
      method: 'GET',
      url: '/portal/v1/terms',
      headers: { 'x-forwarded-for': ip },
    })
    expect(valido.statusCode).toBe(200)
  })

  it('o Admin fica de fora: quem o chama é o Next, um IP só para todos os petshops', async () => {
    const app = await getApp()
    for (let i = 0; i < TETO * 2; i += 1) {
      const recusado = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer inventado-${i}`, 'x-forwarded-for': '198.51.100.5' },
      })
      // 401 até o fim, e nunca 429: a recusa no Admin não é contada.
      expect(recusado.statusCode).toBe(401)
    }
  })
})
