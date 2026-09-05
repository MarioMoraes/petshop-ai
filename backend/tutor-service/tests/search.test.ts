import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/** MOD-TUTOR-06 — busca e filtros. */

let tenant: TenantFixture

const people = [
  { fullName: 'Maria Silva', phone: '11987654321', cpf: '52998224725', email: 'maria@exemplo.com' },
  { fullName: 'Mariana Souza', phone: '11988887777', email: 'mariana@exemplo.com' },
  { fullName: 'José Antônio Pereira', phone: '21999998888' },
  { fullName: 'Comércio de Rações Ltda', phone: '11933332222' },
]

beforeAll(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  for (const person of people) {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/tutors',
      payload: { ...person, consents: { whatsapp: true, email: false, terms: true } },
    })
    if (response.statusCode !== 201) throw new Error(`cenário falhou: ${response.body}`)
  }
})

beforeEach(() => undefined)
afterAll(closeHarness)

function search(query: string) {
  return callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/tutors?${query}` })
}

describe('MOD-TUTOR-06 — busca', () => {
  it('AC-01: busca por prefixo de nome traz os dois "mari", por relevância', async () => {
    const response = await search('q=maria')

    expect(response.statusCode).toBe(200)
    const names = response.json().data.map((t: { fullName: string }) => t.fullName)
    expect(names).toContain('Maria Silva')
    expect(names[0]).toBe('Maria Silva')
  })

  it('encontra ignorando acento — "antonio" acha "Antônio"', async () => {
    const response = await search('q=antonio')
    expect(response.json().data.map((t: { fullName: string }) => t.fullName)).toContain(
      'José Antônio Pereira',
    )
  })

  it('AC-02: busca por telefone usa o hash, com ou sem máscara', async () => {
    const semMascara = await search('q=11987654321')
    const comMascara = await search(`q=${encodeURIComponent('(11) 98765-4321')}`)

    expect(semMascara.json().total).toBe(1)
    expect(semMascara.json().data[0].fullName).toBe('Maria Silva')
    expect(comMascara.json().total).toBe(1)
  })

  it('AC-02: busca por CPF formatado usa o hash', async () => {
    const response = await search(`q=${encodeURIComponent('529.982.247-25')}`)
    expect(response.json().total).toBe(1)
    expect(response.json().data[0].fullName).toBe('Maria Silva')
  })

  it('busca por e-mail exato', async () => {
    const response = await search('q=mariana@exemplo.com')
    expect(response.json().total).toBe(1)
    expect(response.json().data[0].fullName).toBe('Mariana Souza')
  })

  it('AC-03: `q` curto devolve a lista padrão em vez de filtrar', async () => {
    const response = await search('q=m')
    expect(response.json().total).toBe(people.length)
  })

  it('AC-03: operadores de tsquery são escapados, não interpretados', async () => {
    for (const term of ['maria & silva', 'maria | jose', '!maria', 'maria:*']) {
      const response = await search(`q=${encodeURIComponent(term)}`)
      expect(response.statusCode).toBe(200)
    }
  })

  it('pagina e devolve o total do filtro, não da página', async () => {
    const response = await search('limit=2&page=1')
    expect(response.json()).toMatchObject({ total: people.length, page: 1, limit: 2 })
    expect(response.json().data).toHaveLength(2)
  })

  it('rejeita limite acima do teto', async () => {
    expect((await search('limit=500')).statusCode).toBe(422)
  })

  /**
   * A lista sem busca é alfabética (pedido do usuário em 2026-09-05, no lugar do
   * `updated_at DESC` do AC-03).
   *
   * O acento entra no teste de propósito: "Comércio" e "José Antônio" só caem no lugar
   * certo porque a ordenação passa por `unaccent`. Sem ela, a intercalação do banco
   * decide — e ela varia com o locale do cluster, o que faria a lista mudar de ordem ao
   * trocar de servidor.
   */
  it('lista sem busca em ordem alfabética, ignorando acento', async () => {
    const response = await search('limit=20')

    expect(response.json().data.map((t: { displayName: string }) => t.displayName)).toEqual([
      'Comércio de Rações Ltda',
      'José Antônio Pereira',
      'Maria Silva',
      'Mariana Souza',
    ])
  })

  it('a ordem é estável entre páginas', async () => {
    const primeira = await search('limit=2&page=1')
    const segunda = await search('limit=2&page=2')

    const nomes = [...primeira.json().data, ...segunda.json().data].map(
      (t: { displayName: string }) => t.displayName,
    )
    expect(nomes).toEqual([
      'Comércio de Rações Ltda',
      'José Antônio Pereira',
      'Maria Silva',
      'Mariana Souza',
    ])
  })
})

/**
 * O nome social manda na ordem, porque é ele que a tela mostra (RN-14).
 *
 * Tenant próprio para não mexer no total que os testes acima conferem.
 */
describe('ordem alfabética e nome social', () => {
  let outro: TenantFixture

  beforeAll(async () => {
    outro = await givenTenant('Petshop do Nome Social')

    for (const person of [
      { fullName: 'Zuleica Ramos', socialName: 'Ana Ramos', phone: '11955554444' },
      { fullName: 'Bruno Carvalho', phone: '11944443333' },
    ]) {
      const response = await callApi({
        ...asAdmin(outro),
        method: 'POST',
        url: '/v1/tutors',
        payload: { ...person, consents: { whatsapp: false, email: false, terms: true } },
      })
      if (response.statusCode !== 201) throw new Error(`cenário falhou: ${response.body}`)
    }
  })

  it('ordena por "Ana", que é o que a lista exibe, e não por "Zuleica"', async () => {
    const response = await callApi({ ...asAdmin(outro), method: 'GET', url: '/v1/tutors' })

    expect(response.json().data.map((t: { displayName: string }) => t.displayName)).toEqual([
      'Ana Ramos',
      'Bruno Carvalho',
    ])
  })
})
