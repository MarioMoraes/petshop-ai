import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asReceptionist,
  callApi,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

const { setResendDomainsPort } = await import('../../src/modules/messaging/ports/resend-domains.js')
type ResendDomainsPort =
  import('../../src/modules/messaging/ports/resend-domains.js').ResendDomainsPort
type ProviderDomainStatus =
  import('../../src/modules/messaging/ports/resend-domains.js').ProviderDomainStatus
const { ResendDomainsError } = await import('../../src/modules/messaging/ports/resend-domains.js')
const { checkPendingDomains } = await import('../../src/modules/messaging/email-domain.js')
const { dispatchTenant } = await import('../../src/modules/messaging/dispatch.js')

/**
 * O domínio de e-mail próprio (Configurações › Integrações).
 *
 * O Resend é dublado: um mapa de domínios em memória, com o estado que o teste mandar. O
 * que se prova é o que é nosso — normalização, o domínio único entre tenants, o remetente
 * que só muda com o DNS verificado e a varredura que desiste depois de 72 horas.
 */

interface FakeDomains {
  /** O estado que o próximo `get` devolve, por id. */
  status: Map<string, ProviderDomainStatus>
  removed: string[]
}

function installFakeDomains(options: { configured?: boolean } = {}): FakeDomains {
  const status = new Map<string, ProviderDomainStatus>()
  const names = new Set<string>()
  const removed: string[] = []
  let seq = 0

  const port: ResendDomainsPort = {
    configured: () => options.configured ?? true,
    async create(domain) {
      if (names.has(domain)) throw new ResendDomainsError(403, 'The domain already exists')
      names.add(domain)
      seq += 1
      const id = `dom_${seq}`
      status.set(id, 'PENDING')
      return {
        id,
        status: 'PENDING',
        records: [
          {
            record: 'DKIM',
            type: 'TXT',
            name: 'resend._domainkey',
            value: 'p=MIGf...',
            priority: null,
            verified: false,
          },
        ],
      }
    },
    async get(id) {
      return { id, status: status.get(id) ?? 'PENDING', records: [] }
    },
    async verify() {},
    async remove(id) {
      removed.push(id)
    },
  }
  setResendDomainsPort(port)
  return { status, removed }
}

let tenant: TenantFixture
let domains: FakeDomains
let email: FakePort

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  domains = installFakeDomains()
  email = installFakeEmailPort()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function cadastrar(payload: Record<string, unknown>, fixture = tenant) {
  return callApi({ ...asAdmin(fixture), method: 'PUT', url: '/v1/messaging/email-domain', payload })
}

describe('o cadastro do domínio', () => {
  it('normaliza o que o petshop digita e devolve os registros de DNS', async () => {
    const response = await cadastrar({ domain: ' https://www.MeuPet.com.br/ ', localPart: 'Oi' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      available: true,
      domain: {
        domain: 'meupet.com.br',
        localPart: 'oi',
        fromAddress: 'oi@meupet.com.br',
        status: 'PENDING',
      },
    })
    expect(response.json().domain.records).toHaveLength(1)
    expect(
      await ownerPrisma.auditLog.count({
        where: { tenantId: tenant.tenantId, action: 'messaging.email_domain_set' },
      }),
    ).toBe(1)
  })

  it('o endereço padrão é contato@', async () => {
    const response = await cadastrar({ domain: 'meupet.com.br' })
    expect(response.json().domain.fromAddress).toBe('contato@meupet.com.br')
  })

  it('o mesmo domínio não serve a dois estabelecimentos', async () => {
    const outro = await givenTenant()
    await cadastrar({ domain: 'meupet.com.br' })

    const response = await cadastrar({ domain: 'meupet.com.br' }, outro)

    expect(response.statusCode).toBe(409)
  })

  it('trocar de domínio tira o antigo do provedor', async () => {
    await cadastrar({ domain: 'meupet.com.br' })
    await cadastrar({ domain: 'outropet.com.br' })

    expect(domains.removed).toEqual(['dom_1'])
  })

  it('a recepção vê o domínio e não o muda', async () => {
    const recepcao = await asReceptionist(tenant)

    const get = await callApi({ ...recepcao, method: 'GET', url: '/v1/messaging/email-domain' })
    const put = await callApi({
      ...recepcao,
      method: 'PUT',
      url: '/v1/messaging/email-domain',
      payload: { domain: 'meupet.com.br' },
    })

    expect(get.statusCode).toBe(200)
    expect(put.statusCode).toBe(403)
  })

  it('sem acesso a domínios na instalação, a tela sabe e o cadastro é recusado', async () => {
    installFakeDomains({ configured: false })

    const get = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/messaging/email-domain',
    })
    const put = await cadastrar({ domain: 'meupet.com.br' })

    expect(get.json().available).toBe(false)
    expect(put.statusCode).toBe(502)
  })
})

describe('o remetente', () => {
  async function enviarLembrete(dedupeKey: string) {
    const tutorId = await givenTutor(tenant, { phone: '' })
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/messages',
      payload: { tutorId, channel: 'EMAIL', templateKey: 'appointment_reminder', dedupeKey },
    })
    await dispatchTenant(tenant.tenantId, { jitter: false })
  }

  it('só muda quando o DNS verifica', async () => {
    await enableMessaging(tenant)
    await cadastrar({ domain: 'meupet.com.br' })

    await enviarLembrete('antes')
    expect(email.sent[0]?.from).toBeNull()

    domains.status.set('dom_1', 'VERIFIED')
    const verify = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/messaging/email-domain/verify',
    })
    expect(verify.json().domain.status).toBe('VERIFIED')

    await enviarLembrete('depois')
    expect(email.sent[1]?.from).toBe('contato@meupet.com.br')
  })

  it('o aviso para a equipe continua saindo pelo endereço da plataforma', async () => {
    await enableMessaging(tenant)
    await cadastrar({ domain: 'meupet.com.br' })
    domains.status.set('dom_1', 'VERIFIED')
    await callApi({ ...asAdmin(tenant), method: 'POST', url: '/v1/messaging/email-domain/verify' })

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/messages',
      payload: {
        recipientKind: 'USER',
        userId: tenant.userId,
        templateKey: 'tenant_welcome',
        dedupeKey: 'boas-vindas',
      },
    })
    await dispatchTenant(tenant.tenantId, { jitter: false })

    expect(email.sent[0]?.from).toBeNull()
  })

  it('remover volta ao endereço da plataforma na hora', async () => {
    await enableMessaging(tenant)
    await cadastrar({ domain: 'meupet.com.br' })
    domains.status.set('dom_1', 'VERIFIED')
    await callApi({ ...asAdmin(tenant), method: 'POST', url: '/v1/messaging/email-domain/verify' })

    await callApi({ ...asAdmin(tenant), method: 'DELETE', url: '/v1/messaging/email-domain' })
    await enviarLembrete('sem-dominio')

    expect(email.sent[0]?.from).toBeNull()
    expect(domains.removed).toEqual(['dom_1'])
  })
})

describe('a varredura dos pendentes', () => {
  it('verifica sozinha quando o DNS propaga', async () => {
    await cadastrar({ domain: 'meupet.com.br' })
    domains.status.set('dom_1', 'VERIFIED')

    const result = await checkPendingDomains(new Date())

    expect(result.verified).toBe(1)
    const row = await ownerPrisma.emailDomain.findUniqueOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(row.status).toBe('VERIFIED')
    expect(row.verifiedAt).not.toBeNull()
  })

  it('desiste depois de 72 horas', async () => {
    await cadastrar({ domain: 'meupet.com.br' })

    const depois = new Date(Date.now() + 73 * 3_600_000)
    const result = await checkPendingDomains(depois)

    expect(result.failed).toBe(1)
    const row = await ownerPrisma.emailDomain.findUniqueOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(row.status).toBe('FAILED')
  })
})
