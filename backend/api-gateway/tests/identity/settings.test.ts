import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
  type IdentityTenant,
} from './fixtures.js'

/**
 * Perfil público do estabelecimento (MOD-SITE-02) — endereço e telefones.
 *
 * Antes destes campos o tenant não tinha endereço em lugar nenhum do schema: havia
 * CNPJ cifrado e endereço de tutor, e as zonas do taxi são por faixa de CEP, mas o
 * petshop não tinha rua. Sem isso não há site, mapa, SEO local nem cabeçalho de recibo.
 */

const ADDRESS = {
  zipCode: '01310-100',
  street: 'Avenida Paulista',
  number: '1578',
  complement: 'Loja 2',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'sp',
}

let session: IdentityTenant

/**
 * O tenant é provisionado **uma vez** para o arquivo inteiro, e não a cada teste.
 *
 * Provisionar custa caro (cria a Organization no Clerk dublê, semeia catálogo de
 * serviços e escreve a membership), e num `beforeEach` de dez testes isso estourava o
 * `hookTimeout` de 60s quando a suíte do monorepo roda em paralelo — dez pacotes
 * disputando o mesmo Postgres. O isolamento que estes testes precisam é só das
 * **configurações**, e isso é um UPDATE.
 */
beforeAll(async () => {
  await resetDatabase()
  resetFakeClerk()
  session = await givenTenant('petshop-do-joao')
})

/** Devolve `tenant_settings` ao estado de recém-provisionado. */
beforeEach(async () => {
  await ownerPrisma.tenantSettings.update({
    where: { tenantId: session.tenantId },
    data: {
      timezone: 'America/Sao_Paulo',
      cancellationWindowHours: 24,
      minBookingNoticeHours: 2,
      noShowFeePercent: 0,
      addressZip: null,
      addressStreet: null,
      addressNumber: null,
      addressComplement: null,
      addressDistrict: null,
      addressCity: null,
      addressState: null,
      publicPhone: null,
      publicWhatsapp: null,
    },
  })
})

afterAll(closeHarness)

describe('endereço público do estabelecimento', () => {
  it('grava e devolve o endereço, normalizando CEP e UF', async () => {
    const saved = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { address: ADDRESS },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json().address).toEqual({
      zipCode: '01310100',
      street: 'Avenida Paulista',
      number: '1578',
      complement: 'Loja 2',
      district: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    })

    const read = await callApi({
      method: 'GET',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
    })
    expect(read.json().address.city).toBe('São Paulo')
  })

  it('nasce nulo — o tenant provisionado não tem endereço', async () => {
    const read = await callApi({
      method: 'GET',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
    })
    expect(read.json().address).toBeNull()
    expect(read.json().publicPhone).toBeNull()
  })

  it('apaga o endereço com null, e não confunde com "não mexer"', async () => {
    await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { address: ADDRESS },
    })

    const cleared = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { address: null },
    })
    expect(cleared.json().address).toBeNull()

    const row = await ownerPrisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: session.tenantId },
    })
    expect(row.addressCity).toBeNull()
    expect(row.addressState).toBeNull()
  })

  /**
   * O bug que este teste tranca: `.partial()` **não** remove os `.default()` do Zod.
   * Antes da correção, um PATCH só do fuso chegava ao serviço carregando
   * `address: null` e `cancellationWindowHours: 24` — e gravava os dois, apagando o
   * endereço e desfazendo a política que o tenant tinha customizado.
   */
  it('PATCH parcial não apaga endereço nem redefine política', async () => {
    await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { address: ADDRESS, cancellationWindowHours: 48 },
    })

    const afterUnrelated = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { timezone: 'America/Bahia' },
    })

    expect(afterUnrelated.json().timezone).toBe('America/Bahia')
    expect(afterUnrelated.json().address).not.toBeNull()
    expect(afterUnrelated.json().address.street).toBe('Avenida Paulista')
    expect(afterUnrelated.json().cancellationWindowHours).toBe(48)
  })

  it('recusa endereço pela metade', async () => {
    const response = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { address: { zipCode: '01310-100', street: 'Avenida Paulista' } },
    })
    expect(response.statusCode).toBe(422)
  })

  it('recusa CEP inválido', async () => {
    const response = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { address: { ...ADDRESS, zipCode: '123' } },
    })
    expect(response.statusCode).toBe(422)
  })
})

describe('telefones públicos', () => {
  it('normaliza para E.164 e aceita fixo', async () => {
    const saved = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { publicPhone: '(11) 3000-0000', publicWhatsapp: '11987654321' },
    })

    expect(saved.json().publicPhone).toBe('+551130000000')
    expect(saved.json().publicWhatsapp).toBe('+5511987654321')
  })

  it('string vazia apaga o número, em vez de ser inválida', async () => {
    await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { publicPhone: '(11) 3000-0000' },
    })

    const cleared = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { publicPhone: '' },
    })
    expect(cleared.json().publicPhone).toBeNull()
  })

  it('recusa telefone inválido', async () => {
    const response = await callApi({
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      ...asAdmin(session),
      payload: { publicPhone: '99999' },
    })
    expect(response.statusCode).toBe(422)
  })
})

describe('permissão', () => {
  it('recepção lê, mas não altera o endereço', async () => {
    const receptionist = await asRole(session, 'RECEPTIONIST')

    const read = await callApi({
      ...receptionist,
      method: 'GET',
      url: '/v1/tenants/me/settings',
    })
    expect(read.statusCode).toBe(200)

    const write = await callApi({
      ...receptionist,
      method: 'PATCH',
      url: '/v1/tenants/me/settings',
      payload: { address: ADDRESS },
    })
    expect(write.statusCode).toBe(403)
  })
})
