import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  asAdmin,
  asReceptionist,
  callApi,
  callPublic,
  closeHarness,
  givenService,
  givenTenant,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * O site do estabelecimento: publicação, payload público e vitrine.
 *
 * O que estes testes protegem, acima de tudo, é a **fronteira das duas superfícies**:
 * a pública não exige assinatura nenhuma e a administrativa não passa sem ela. Um erro
 * ali ou tranca o site atrás de um login ou publica a configuração do petshop para o
 * mundo — e nenhum dos dois aparece em produção até ser tarde.
 */

afterAll(closeHarness)
beforeEach(resetDatabase)

async function publish(fixture: TenantFixture) {
  return callApi({ ...asAdmin(fixture), method: 'POST', url: '/v1/site/publish' })
}

describe('publicação (MOD-SITE-01)', () => {
  it('publica quando há endereço, contato e serviço', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { priceCents: [5000, 7000] })

    const response = await publish(fixture)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ published: true })
    expect(response.json().publishedAt).not.toBeNull()
  })

  /**
   * Publicar uma página que não diz onde o petshop fica é pior que não ter página:
   * quem chega nela conclui que o negócio não existe mais.
   */
  it('recusa sem endereço, e diz o que falta', async () => {
    const fixture = await givenTenant({ withAddress: false })
    await givenService(fixture)

    const response = await publish(fixture)

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_SITE_001')
    expect(response.json().missing).toEqual(['address'])
  })

  it('recusa sem telefone nem WhatsApp público', async () => {
    const fixture = await givenTenant({ withContact: false })
    await givenService(fixture)

    expect((await publish(fixture)).json().missing).toEqual(['contact'])
  })

  /** Sem serviço visível, a página não diz o que o petshop faz. */
  it('recusa quando nenhum serviço aparece no site', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { showOnSite: false })

    expect((await publish(fixture)).json().missing).toEqual(['service'])
  })

  it('republicar não reescreve a data da primeira publicação', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)

    const first = (await publish(fixture)).json().publishedAt
    await callApi({ ...asAdmin(fixture), method: 'POST', url: '/v1/site/unpublish' })
    const second = (await publish(fixture)).json().publishedAt

    expect(second).toBe(first)
  })
})

describe('payload público (MOD-SITE-05, 06 e 07)', () => {
  async function published(options: Parameters<typeof givenTenant>[0] = {}) {
    const fixture = await givenTenant(options)
    await givenService(fixture, { name: 'Banho', priceCents: [5000, 7000, 9000] })
    await publish(fixture)
    return fixture
  }

  it('serve a página sem autenticação nenhuma', async () => {
    const fixture = await published()

    const response = await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })

    expect(response.statusCode).toBe(200)
    expect(response.json().tenant).toMatchObject({ name: 'Petshop do João', slug: fixture.slug })
  })

  /** RN-04: piso, nunca preço exato — o site não sabe qual é o pet. */
  it('mostra o menor preço da tabela como “a partir de”', async () => {
    const fixture = await published()

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services).toHaveLength(1)
    expect(site.services[0].fromPriceCents).toBe(5000)
  })

  /**
   * Preço zero é preço **não preenchido**, não preço grátis: a tela de serviços cria
   * uma linha por porte e a que o petshop não usa fica em branco. Sem o filtro, um
   * banho de R$ 60 com o porte gigante em branco anunciaria "a partir de R$ 0,00".
   */
  it('porte com preço em branco não vira “a partir de R$ 0,00”', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { name: 'Banho', priceCents: [0, 6000, 7000] })
    await publish(fixture)

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services[0].fromPriceCents).toBe(6000)
  })

  it('serviço com todos os portes em branco aparece como “consulte”', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { name: 'Tosa', priceCents: [0, 0, 0] })
    await publish(fixture)

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services[0].fromPriceCents).toBeNull()
  })

  /** AC-02: sumir esconderia do cliente um serviço que o petshop presta. */
  it('serviço sem tabela de preço aparece sem faixa, e não some', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { name: 'Consulta', priceCents: [] })
    await publish(fixture)

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services).toHaveLength(1)
    expect(site.services[0].fromPriceCents).toBeNull()
  })

  /** AC-03: corrida se pede pelo painel do Taxi Dog, não como se fosse um banho. */
  it('o serviço de categoria TAXI fica fora da vitrine', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { name: 'Banho', priceCents: [5000] })
    await givenService(fixture, { name: 'Leva e traz', category: 'TAXI', priceCents: [2000] })
    await publish(fixture)

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services.map((service: { name: string }) => service.name)).toEqual(['Banho'])
  })

  /** AC-04: a vitrine é subconjunto do catálogo, não espelho dele. */
  it('serviço com “mostrar no site” desmarcado sai da vitrine', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { name: 'Banho', priceCents: [5000] })
    await givenService(fixture, { name: 'Hidratação', showOnSite: false, priceCents: [3000] })
    await publish(fixture)

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services.map((service: { name: string }) => service.name)).toEqual(['Banho'])
  })

  it('serviço desativado não aparece', async () => {
    const fixture = await givenTenant()
    await givenService(fixture, { name: 'Banho', priceCents: [5000] })
    await givenService(fixture, { name: 'Tosa antiga', active: false })
    await publish(fixture)

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.services).toHaveLength(1)
  })

  /**
   * AC-02 de MOD-SITE-07: com o agendamento online desligado o botão principal vira
   * WhatsApp — e não um "Agendar" que leva a uma porta fechada.
   */
  it('sem agendamento online, não há destino de agendamento', async () => {
    const fixture = await published({ onlineBookingEnabled: false })

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.cta.bookingUrl).toBeNull()
  })

  it('com agendamento online, o destino é o Portal no host do tenant', async () => {
    const fixture = await published()

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.cta.bookingUrl).toContain(`${fixture.slug}.`)
    expect(site.cta.bookingUrl).toMatch(/\/portal$/)
  })

  it('o horário e o fuso vão embarcados, para o selo ser calculado no cliente', async () => {
    const fixture = await published()

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.tenant.timezone).toBe('America/Sao_Paulo')
    expect(site.businessHours.sunday.closed).toBe(true)
    expect(site.businessHours.saturday.closesAt).toBe('13:00')
  })
})

describe('quem não vê a página (RN-06 e AC-03)', () => {
  it('site despublicado responde 404, não 403', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site?slug=${fixture.slug}`,
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_SITE_006')
  })

  it('despublicar tira a página do ar', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)
    await publish(fixture)

    await callApi({ ...asAdmin(fixture), method: 'POST', url: '/v1/site/unpublish' })

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site?slug=${fixture.slug}`,
    })
    expect(response.statusCode).toBe(404)
  })

  /**
   * O site é entrega comercial e acompanha o estado da conta: uma página no ar de um
   * cliente que parou de pagar é a pior propaganda possível do produto.
   */
  it('tenant fora de ACTIVE responde 404 mesmo publicado', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)
    await publish(fixture)

    await withTenant(fixture.tenantId, (tx) =>
      tx.tenant.update({ where: { id: fixture.tenantId }, data: { status: 'SUSPENDED' } }),
    )

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site?slug=${fixture.slug}`,
    })
    expect(response.statusCode).toBe(404)
  })

  /**
   * O tenant nasce em `TRIAL` e passa nele os primeiros trinta dias. Um site que só
   * responde em `ACTIVE` nasceria fora do ar para todo cliente novo — que é
   * exatamente quem mais quer ver a página funcionando.
   */
  it.each(['TRIAL', 'PAST_DUE'] as const)('tenant em %s continua com site no ar', async (status) => {
    const fixture = await givenTenant({ status })
    await givenService(fixture)
    await publish(fixture)

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site?slug=${fixture.slug}`,
    })
    expect(response.statusCode).toBe(200)
  })

  it('slug inexistente responde 404, sem dizer mais nada', async () => {
    const response = await callPublic({ method: 'GET', url: '/public/v1/site?slug=nao-existe' })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_SITE_006')
  })
})

describe('as duas superfícies (§5)', () => {
  /**
   * A superfície administrativa não passa sem a assinatura do gateway. Alcançar a
   * porta do serviço direto, pulando o gateway, não pode valer nada.
   */
  it('a rota administrativa recusa requisição sem assinatura', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)

    const response = await callPublic({ method: 'GET', url: '/v1/site/settings' })

    expect(response.statusCode).toBe(401)
  })

  it('a rota pública não exige assinatura nenhuma', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)
    await publish(fixture)

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site?slug=${fixture.slug}`,
    })

    expect(response.statusCode).toBe(200)
  })

  /** Publicar é do administrador; a recepção trabalha os contatos (§9). */
  it('a recepção não publica o site', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)

    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'POST',
      url: '/v1/site/publish',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_SITE_008')
  })
})

describe('conteúdo (MOD-SITE-03)', () => {
  /**
   * O defeito que o `.partial()` do Zod já causou uma vez em `tenant_settings`:
   * `.partial()` **não** remove `.default()`, e um PATCH parcial montado a partir do
   * schema completo regravaria os defaults por cima do que o tenant customizou.
   */
  it('o PATCH parcial não regrava o que não foi enviado', async () => {
    const fixture = await givenTenant()

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { showPrices: false, headline: 'Cuidamos do seu melhor amigo' },
    })

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { notice: 'Fechados dia 25' },
    })

    const settings = (
      await callApi({ ...asAdmin(fixture), method: 'GET', url: '/v1/site/settings' })
    ).json()

    expect(settings.showPrices).toBe(false)
    expect(settings.headline).toBe('Cuidamos do seu melhor amigo')
    expect(settings.notice).toBe('Fechados dia 25')
  })

  it('campo em branco apaga o texto — apagar o aviso tira a faixa', async () => {
    const fixture = await givenTenant()

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { notice: 'Fechados dia 25' },
    })
    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { notice: null },
    })

    const settings = (
      await callApi({ ...asAdmin(fixture), method: 'GET', url: '/v1/site/settings' })
    ).json()

    expect(settings.notice).toBeNull()
  })

  /** Chave desconhecida não passa em silêncio — o defeito que o MOD-CRM já teve. */
  it('recusa campo que o schema não conhece', async () => {
    const fixture = await givenTenant()

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { headlineTexto: 'errado' },
    })

    expect(response.statusCode).toBe(422)
  })

  /**
   * Não há editor rico, não há HTML do usuário na página e portanto não há XSS
   * armazenado a defender: o `<b>` que o admin digitar é gravado e exibido literal.
   */
  it('marcação no texto é gravada como texto puro', async () => {
    const fixture = await givenTenant()

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { headline: '<b>Banho</b> e tosa' },
    })

    const settings = (
      await callApi({ ...asAdmin(fixture), method: 'GET', url: '/v1/site/settings' })
    ).json()

    expect(settings.headline).toBe('<b>Banho</b> e tosa')
  })
})

describe('pré-visualização (§5)', () => {
  it('monta a página mesmo despublicada e diz o que falta', async () => {
    const fixture = await givenTenant({ withAddress: false })

    const response = await callApi({ ...asAdmin(fixture), method: 'GET', url: '/v1/site/preview' })

    expect(response.statusCode).toBe(200)
    expect(response.json().published).toBe(false)
    expect(response.json().missing).toEqual(['address', 'service'])
    expect(response.json().site.tenant.name).toBe('Petshop do João')
  })
})
