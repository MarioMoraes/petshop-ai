import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asTutor,
  callApi,
  callPublic,
  closeHarness,
  givenTenant,
  givenTutor,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * Os aparelhos do app (etapa 9 — push).
 *
 * O que importa aqui é o **escopo**: o `tutorId` sai da sessão e nunca do corpo, e um
 * token que não é deste tutor não se deixa apagar nem se denuncia. O resto — o dono
 * único, a revogação — tem suíte em `tests/messaging/push.test.ts`.
 */

let fixture: TenantFixture

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
})

afterAll(async () => {
  await closeHarness()
})

const TOKEN = 'fcm-token-de-teste-com-tamanho-bastante'

function devices() {
  return withTenant(fixture.tenantId, (tx) => tx.pushDevice.findMany())
}

describe('POST /portal/v1/devices', () => {
  it('registra o aparelho na ficha de quem está logado, com o token cifrado', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/devices',
      payload: { token: TOKEN, platform: 'ANDROID' },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(204)
    const [device] = await devices()
    expect(device).toMatchObject({ tutorId, platform: 'ANDROID', revokedAt: null })
    expect(device!.tokenEncrypted).not.toContain(TOKEN)
  })

  it('repetir o registro não duplica — é o que o app faz a cada abertura', async () => {
    const tutorId = await givenTutor(fixture)
    for (let i = 0; i < 3; i++) {
      await callApi({
        method: 'POST',
        url: '/portal/v1/devices',
        payload: { token: TOKEN, platform: 'ANDROID' },
        ...asTutor(fixture, tutorId),
      })
    }
    expect(await devices()).toHaveLength(1)
  })

  it('não aceita outro tutor no corpo: o schema é estrito', async () => {
    const tutorId = await givenTutor(fixture)
    const outro = await givenTutor(fixture, { phone: '+5511900001111' })

    const response = await callApi({
      method: 'POST',
      url: '/portal/v1/devices',
      payload: { token: TOKEN, platform: 'ANDROID', tutorId: outro },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(422)
    expect(await devices()).toHaveLength(0)
  })

  it('exige sessão', async () => {
    const response = await callPublic({
      method: 'POST',
      url: '/portal/v1/devices',
      payload: { token: TOKEN, platform: 'ANDROID' },
      slug: fixture.slug,
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('DELETE /portal/v1/devices', () => {
  it('ao sair, o aparelho deixa de ser deste tutor', async () => {
    const tutorId = await givenTutor(fixture)
    await callApi({
      method: 'POST',
      url: '/portal/v1/devices',
      payload: { token: TOKEN, platform: 'ANDROID' },
      ...asTutor(fixture, tutorId),
    })

    const response = await callApi({
      method: 'DELETE',
      url: '/portal/v1/devices',
      payload: { token: TOKEN },
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(204)
    expect(await devices()).toHaveLength(0)
  })

  it('o token de outro tutor não se apaga, e a resposta é a mesma', async () => {
    const dono = await givenTutor(fixture)
    const intruso = await givenTutor(fixture, { phone: '+5511900001111' })
    await callApi({
      method: 'POST',
      url: '/portal/v1/devices',
      payload: { token: TOKEN, platform: 'ANDROID' },
      ...asTutor(fixture, dono),
    })

    const response = await callApi({
      method: 'DELETE',
      url: '/portal/v1/devices',
      payload: { token: TOKEN },
      ...asTutor(fixture, intruso),
    })

    expect(response.statusCode).toBe(204)
    expect(await devices()).toHaveLength(1)
  })
})
