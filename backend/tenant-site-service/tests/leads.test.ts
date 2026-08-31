import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashSearchable, withTenant } from '@petshop/db'
import { TUTOR_PHONE_HASH_NAMESPACE } from '@petshop/shared-types'
import {
  asAdmin,
  asReceptionist,
  callApi,
  callPublic,
  closeHarness,
  givenService,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * Captação, fila e retenção de contatos (MOD-SITE-08, 09 e RN-11).
 *
 * O lead é a primeira categoria de pessoa **sem vínculo nenhum** com o petshop, e é
 * isso que explica quase tudo aqui: a cifra do telefone, o silêncio do honeypot e o
 * prazo de validade do dado.
 */

afterAll(closeHarness)
beforeEach(resetDatabase)

const LEAD = { name: 'Marina Alves', phone: '11987654321', message: 'Quero marcar um banho' }

async function givenPublishedSite(): Promise<TenantFixture> {
  const fixture = await givenTenant()
  await givenService(fixture, { priceCents: [5000] })
  await callApi({ ...asAdmin(fixture), method: 'POST', url: '/v1/site/publish' })
  return fixture
}

function sendLead(slug: string, payload: Record<string, unknown> = LEAD) {
  return callPublic({ method: 'POST', url: `/public/v1/site/leads?slug=${slug}`, payload })
}

describe('captação (MOD-SITE-08)', () => {
  it('grava o contato e responde 201', async () => {
    const fixture = await givenPublishedSite()

    const response = await sendLead(fixture.slug)

    expect(response.statusCode).toBe(201)
    const leads = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findMany())
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ name: 'Marina Alves', status: 'NEW' })
  })

  /** O telefone é dado pessoal de quem ainda não é cliente: nunca em claro. */
  it('cifra o telefone e guarda o hash de busca', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)

    const lead = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findFirstOrThrow())

    expect(lead.phoneEncrypted).not.toContain('11987654321')
    expect(lead.phoneEncrypted.startsWith('v1:')).toBe(true)
    expect(lead.phoneHash).toBe(
      hashSearchable(TUTOR_PHONE_HASH_NAMESPACE, '+5511987654321'),
    )
  })

  /**
   * RN-08. Responder com erro ensinaria o bot a contornar: ele tentaria de novo sem o
   * campo. A resposta é **idêntica** à do sucesso, e nada é gravado.
   */
  it('honeypot preenchido responde 201 e não grava nada', async () => {
    const fixture = await givenPublishedSite()

    const response = await sendLead(fixture.slug, { ...LEAD, website: 'http://spam.example' })

    expect(response.statusCode).toBe(201)
    const count = await withTenant(fixture.tenantId, (tx) => tx.siteLead.count())
    expect(count).toBe(0)
  })

  /**
   * AC-04. A equipe precisa saber que não é aquisição — é um cliente que não achou o
   * WhatsApp. E o visitante não pode perceber diferença nenhuma.
   */
  it('marca o contato que já é cliente, sem contar isso a quem enviou', async () => {
    const fixture = await givenPublishedSite()
    const tutorId = await givenTutor(
      fixture,
      hashSearchable(TUTOR_PHONE_HASH_NAMESPACE, '+5511987654321'),
    )

    const response = await sendLead(fixture.slug)

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ received: true })

    const lead = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findFirstOrThrow())
    expect(lead.existingTutorId).toBe(tutorId)
  })

  it('telefone que não é telefone brasileiro é recusado', async () => {
    const fixture = await givenPublishedSite()

    const response = await sendLead(fixture.slug, { ...LEAD, phone: '123' })

    expect(response.statusCode).toBe(422)
  })

  it('mensagem curta demais é recusada', async () => {
    const fixture = await givenPublishedSite()

    const response = await sendLead(fixture.slug, { ...LEAD, message: 'oi' })

    expect(response.statusCode).toBe(422)
  })

  /** O formulário não é porta de entrada para o site fora do ar. */
  it('site despublicado não aceita contato', async () => {
    const fixture = await givenTenant()
    await givenService(fixture)

    const response = await sendLead(fixture.slug)

    expect(response.statusCode).toBe(404)
  })

  it('formulário desligado não aceita contato', async () => {
    const fixture = await givenPublishedSite()
    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/site/settings',
      payload: { leadFormEnabled: false },
    })

    const response = await sendLead(fixture.slug)

    expect(response.statusCode).toBe(404)
  })
})

describe('fila (MOD-SITE-09)', () => {
  it('a recepção vê a fila, com os novos no topo', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)

    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'GET',
      url: '/v1/site/leads',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().newCount).toBe(1)
    expect(response.json().items[0]).toMatchObject({ name: 'Marina Alves', status: 'NEW' })
  })

  /** O telefone volta decifrado para quem tem permissão — é o que a fila serve. */
  it('a fila devolve o telefone em claro para a equipe', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)

    const items = (
      await callApi({ ...asReceptionist(fixture), method: 'GET', url: '/v1/site/leads' })
    ).json().items

    expect(items[0].phone).toBe('+5511987654321')
  })

  it('quem não tem permissão de contatos não vê a fila', async () => {
    const fixture = await givenPublishedSite()

    const response = await callApi({
      clerkUserId: fixture.clerkUserId,
      userId: fixture.userId,
      tenantId: fixture.tenantId,
      role: 'GROOMER',
      permissions: ['pet:read'],
      method: 'GET',
      url: '/v1/site/leads',
    })

    expect(response.statusCode).toBe(403)
  })

  it('marca como contatado e descarta', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)
    const lead = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findFirstOrThrow())

    const contacted = await callApi({
      ...asReceptionist(fixture),
      method: 'PATCH',
      url: `/v1/site/leads/${lead.id}`,
      payload: { status: 'CONTACTED' },
    })
    expect(contacted.json().status).toBe('CONTACTED')

    const discarded = await callApi({
      ...asReceptionist(fixture),
      method: 'PATCH',
      url: `/v1/site/leads/${lead.id}`,
      payload: { status: 'DISCARDED' },
    })
    expect(discarded.json().status).toBe('DISCARDED')
  })

  it('converte apontando para o tutor que a recepção criou', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)
    const lead = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findFirstOrThrow())
    const tutorId = await givenTutor(fixture, 'outro-hash')

    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'POST',
      url: `/v1/site/leads/${lead.id}/convert`,
      payload: { tutorId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'CONVERTED', convertedTutorId: tutorId })
  })

  /** Convertido é terminal: "desconverter" deixaria a ficha criada sem origem. */
  it('não move um contato já convertido', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)
    const lead = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findFirstOrThrow())
    const tutorId = await givenTutor(fixture, 'outro-hash')

    await callApi({
      ...asReceptionist(fixture),
      method: 'POST',
      url: `/v1/site/leads/${lead.id}/convert`,
      payload: { tutorId },
    })

    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'PATCH',
      url: `/v1/site/leads/${lead.id}`,
      payload: { status: 'DISCARDED' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_SITE_011')
  })

  /** RN-10: ver o contato e criar a ficha são permissões diferentes na matriz. */
  it('converter exige tutor:create além de ver a fila', async () => {
    const fixture = await givenPublishedSite()
    await sendLead(fixture.slug)
    const lead = await withTenant(fixture.tenantId, (tx) => tx.siteLead.findFirstOrThrow())
    const tutorId = await givenTutor(fixture, 'outro-hash')

    const response = await callApi({
      clerkUserId: fixture.clerkUserId,
      userId: fixture.userId,
      tenantId: fixture.tenantId,
      role: 'RECEPTIONIST',
      permissions: ['site:read_leads'],
      method: 'POST',
      url: `/v1/site/leads/${lead.id}/convert`,
      payload: { tutorId },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('retenção (RN-11)', () => {
  /**
   * Guardar telefone de quem nunca virou cliente, indefinidamente, é passivo sem
   * finalidade. A linha fica — para a estatística de quantos contatos chegaram —, o
   * dado pessoal não.
   */
  it('descarta o contato parado há um ano e apaga o PII do descartado há dois', async () => {
    const fixture = await givenPublishedSite()

    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    const ancient = new Date(Date.now() - 800 * 24 * 60 * 60 * 1000)

    await ownerPrisma.siteLead.createMany({
      data: [
        {
          tenantId: fixture.tenantId,
          name: 'Parado',
          phoneEncrypted: 'v1:a:b:c',
          phoneHash: 'h1',
          status: 'NEW',
          createdAt: old,
        },
        {
          tenantId: fixture.tenantId,
          name: 'Antigo',
          phoneEncrypted: 'v1:a:b:c',
          phoneHash: 'h2',
          message: 'quero preço',
          status: 'DISCARDED',
          createdAt: ancient,
        },
      ],
    })

    const { runLeadRetention } = await import('../src/modules/site/jobs.js')
    const result = await runLeadRetention()

    expect(result.discarded).toBe(1)
    expect(result.purged).toBe(1)

    const purged = await ownerPrisma.siteLead.findFirstOrThrow({ where: { phoneHash: '' } })
    expect(purged.name).toBe('(removido)')
    expect(purged.message).toBeNull()
    expect(purged.purgedAt).not.toBeNull()
  })

  /** Antiabuso que olha um ano para trás não serve para nada. */
  it('apaga IP e user-agent depois de 90 dias, em qualquer status', async () => {
    const fixture = await givenPublishedSite()

    await ownerPrisma.siteLead.create({
      data: {
        tenantId: fixture.tenantId,
        name: 'Recente o bastante',
        phoneEncrypted: 'v1:a:b:c',
        phoneHash: 'h3',
        status: 'CONTACTED',
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      },
    })

    const { runLeadRetention } = await import('../src/modules/site/jobs.js')
    const result = await runLeadRetention()

    expect(result.anonymized).toBe(1)
    const lead = await ownerPrisma.siteLead.findFirstOrThrow({ where: { phoneHash: 'h3' } })
    expect(lead.ipAddress).toBeNull()
    expect(lead.userAgent).toBeNull()
    // O contato em si continua lá: só o metadado de antiabuso venceu.
    expect(lead.name).toBe('Recente o bastante')
  })
})
