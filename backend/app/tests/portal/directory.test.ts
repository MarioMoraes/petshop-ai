import { beforeEach, describe, expect, it } from 'vitest'
import { PORTAL_DIRECTORY_LIMIT, type PortalDirectoryResponse } from '@petshop/shared-types'
import { getApp, givenTenant, resetDatabase } from './fixtures.js'

/**
 * O catálogo de estabelecimentos da primeira tela do app (2026-09-21).
 *
 * O que esta suíte guarda não é o formato da resposta — é o **critério**. A lista existe
 * para o tutor achar o petshop pelo nome em vez de digitar o slug, e a promessa que ela
 * faz é que a tela seguinte abre. Um petshop que entre aqui e responda 404 ou 403 depois
 * é pior do que não ter lista: manda a pessoa para um beco e a faz achar que o app está
 * quebrado.
 *
 * Por isso cada caso de exclusão tem um teste: estado da conta, plano e interruptor são
 * três portas diferentes, e cada uma já esqueceu de ser conferida em algum lugar deste
 * repositório.
 */

async function catalogo(): Promise<PortalDirectoryResponse> {
  const app = await getApp()
  // Sem header de slug **de propósito**: é a pergunta de quem ainda não sabe o slug, e
  // a rota que exigisse o header seria inútil para a tela que a motivou.
  const resposta = await app.inject({ method: 'GET', url: '/public/v1/portal/tenants' })
  expect(resposta.statusCode).toBe(200)
  return resposta.json() as PortalDirectoryResponse
}

describe('catálogo de estabelecimentos', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('traz o que está na fachada, e nada além', async () => {
    const tenant = await givenTenant({ name: 'Petshop Amarillys' })
    const { tenants, truncated } = await catalogo()

    expect(truncated).toBe(false)
    const entrada = tenants.find((item) => item.slug === tenant.slug)
    expect(entrada).toEqual({
      slug: tenant.slug,
      name: 'Petshop Amarillys',
      logoUrl: 'https://cdn/logo.png',
      brandColor: '#2E7D32',
    })
    // Nada de operação e nada de pessoa: a fachada é o contrato.
    expect(Object.keys(entrada!)).toHaveLength(4)
  })

  it('não exige sessão nem slug: é anônima', async () => {
    await givenTenant()
    const app = await getApp()
    const resposta = await app.inject({ method: 'GET', url: '/public/v1/portal/tenants' })

    expect(resposta.statusCode).toBe(200)
  })

  it('deixa de fora quem desligou o Portal', async () => {
    const ligado = await givenTenant({ name: 'Com portal' })
    const desligado = await givenTenant({ portalEnabled: false, name: 'Sem portal' })

    const { tenants } = await catalogo()
    const slugs = tenants.map((item) => item.slug)

    expect(slugs).toContain(ligado.slug)
    // O Portal desligado responde 403 no primeiro `/me` (RN-15). Oferecê-lo seria pôr
    // um beco sem saída no catálogo.
    expect(slugs).not.toContain(desligado.slug)
  })

  it('deixa de fora o plano sem Portal', async () => {
    const pro = await givenTenant({ plan: 'PRO' })
    const starter = await givenTenant({ plan: 'STARTER' })

    const { tenants } = await catalogo()
    const slugs = tenants.map((item) => item.slug)

    expect(slugs).toContain(pro.slug)
    expect(slugs).not.toContain(starter.slug)
  })

  it('deixa de fora a conta que não está visível', async () => {
    const ativo = await givenTenant({ status: 'ACTIVE' })
    const atraso = await givenTenant({ status: 'PAST_DUE' })
    const suspenso = await givenTenant({ status: 'SUSPENDED' })
    const encerrado = await givenTenant({ status: 'TERMINATED' })

    const { tenants } = await catalogo()
    const slugs = tenants.map((item) => item.slug)

    expect(slugs).toContain(ativo.slug)
    // Quem está em atraso trabalha durante a carência — e os clientes dele também.
    expect(slugs).toContain(atraso.slug)
    expect(slugs).not.toContain(suspenso.slug)
    expect(slugs).not.toContain(encerrado.slug)
  })

  it('o critério é o mesmo que a tela seguinte aplica', async () => {
    await givenTenant({ name: 'A' })
    await givenTenant({ portalEnabled: false, name: 'B' })
    await givenTenant({ plan: 'STARTER', name: 'C' })
    await givenTenant({ status: 'SUSPENDED', name: 'D' })

    const { tenants } = await catalogo()
    const app = await getApp()

    // A prova que importa: tudo que a lista oferece, a rota do estabelecimento aceita.
    for (const entrada of tenants) {
      const resposta = await app.inject({
        method: 'GET',
        url: '/portal/v1/tenant',
        headers: { 'x-petshop-tenant-slug': entrada.slug },
      })
      expect(resposta.statusCode, `slug ${entrada.slug}`).toBe(200)
      expect((resposta.json() as { portalEnabled: boolean }).portalEnabled).toBe(true)
    }
  })

  it('vem em ordem de nome, que é como se procura numa lista', async () => {
    await givenTenant({ name: 'Zoológico Pet' })
    await givenTenant({ name: 'Amigo Fiel' })
    await givenTenant({ name: 'Mundo Animal' })

    const { tenants } = await catalogo()
    const nomes = tenants.map((item) => item.name)

    expect(nomes).toEqual([...nomes].sort((a, b) => a.localeCompare(b)))
  })

  it('o teto não é uma promessa vazia: ele vem anunciado', async () => {
    // O teto de verdade é alto demais para semear numa suíte; o que se prende aqui é a
    // existência do aviso, para que o dia de trocar o catálogo por uma busca chegue
    // como sinal e não como reclamação de quem não se achou.
    expect(PORTAL_DIRECTORY_LIMIT).toBeGreaterThan(0)
    const { truncated } = await catalogo()
    expect(truncated).toBe(false)
  })
})
