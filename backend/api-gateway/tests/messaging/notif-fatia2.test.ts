import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  authHeaders,
  closeHarness,
  enableMessaging,
  getApp,
  givenBranding,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  resetDatabase,
  resetPorts,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-NOTIF fatia 2 — identidade do remetente (03) e molde de marca (04).
 *
 * As sub-features 06 a 09 são exercitadas do lado do crm-automation-service, que é quem
 * traduz o fato do domínio em pedido de envio. O que se prova aqui é o que o motor faz
 * com o pedido: por qual remetente sai, e dentro de que moldura.
 */

let fixture: TenantFixture
let email: FakePort

beforeAll(async () => {
  await getApp()
})

afterAll(async () => {
  await closeHarness()
})

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  email = installFakeEmailPort()
  fixture = await givenTenant()
})

/**
 * O administrador, com o token que o Admin apresentaria. As permissões saem da matriz
 * pelo `membership`, e não de uma lista aqui — `TENANT_ADMIN` tem as três de CRM.
 */
function asAdmin() {
  return authHeaders({ clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId })
}

async function enqueue(body: Record<string, unknown>) {
  const app = await getApp()
  return app.inject({ method: 'POST', url: '/v1/messages', headers: asAdmin(), payload: body })
}

async function dispatchNow() {
  const { dispatchTenant } = await import('../../src/modules/messaging/dispatch.js')
  return dispatchTenant(fixture.tenantId, { jitter: false })
}

/** Um texto do produto, para exercitar o molde de marca. */
async function sendSystemText(): Promise<void> {
  await enqueue({
    recipientKind: 'USER',
    userId: fixture.userId,
    templateKey: 'tenant_welcome',
    dedupeKey: `sistema-${Math.random().toString(36).slice(2)}`,
  })
  await dispatchNow()
}

// ─── MOD-NOTIF-03 — identidade do remetente ──────────────────────────────────

describe('MOD-NOTIF-03 — identidade do remetente', () => {
  it('AC-01: o nome e o responder-para do petshop viajam com o envio', async () => {
    await enableMessaging(fixture, {
      senderName: 'Petshop do João',
      replyToEmail: 'contato@petshopdojoao.com.br',
    })
    const tutorId = await givenTutor(fixture, { phone: '' })

    await enqueue({ tutorId, channel: 'EMAIL', templateKey: 'appointment_reminder', dedupeKey: 'r1' })
    await dispatchNow()

    // Quem responder fala com o petshop, e não com o vazio.
    expect(email.sent[0]?.senderName).toBe('Petshop do João')
    expect(email.sent[0]?.replyTo).toBe('contato@petshopdojoao.com.br')
  })

  it('AC-04: responder-para inválido é recusado na gravação, não no envio', async () => {
    const app = await getApp()
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/messaging/settings',
      headers: asAdmin(),
      payload: { replyToEmail: 'nao-e-um-email' },
    })

    // Endereço inválido descoberto no despacho vira falha permanente de uma mensagem
    // que era boa — e a falha aparece longe de quem a causou.
    expect(response.statusCode).toBe(422)
  })
})

// ─── MOD-NOTIF-04 — molde de marca ───────────────────────────────────────────

describe('MOD-NOTIF-04 — molde de marca', () => {
  it('AC-01: texto do produto sai com logo, cor e rodapé do estabelecimento', async () => {
    await enableMessaging(fixture)
    await givenBranding(fixture, { logoUrl: 'https://cdn.test/logo.png', primaryColor: '#1B7F5A' })

    await sendSystemText()

    const html = email.sent[0]?.html ?? ''
    expect(html).toContain('https://cdn.test/logo.png')
    expect(html).toContain('#1B7F5A')
    // O rodapé nomeia o estabelecimento e diz onde ele fica.
    expect(html).toContain('Petshop Teste')
    expect(html).toContain('Avenida Paulista')
    expect(html).toContain('(11) 4002-8922')
  })

  it('AC-02: texto do petshop continua saindo sem moldura', async () => {
    await enableMessaging(fixture)
    await givenBranding(fixture, { logoUrl: 'https://cdn.test/logo.png' })
    const tutorId = await givenTutor(fixture, { phone: '' })

    await enqueue({ tutorId, channel: 'EMAIL', templateKey: 'appointment_reminder', dedupeKey: 'r2' })
    await dispatchNow()

    // Quem edita o texto na tela do CRM não escreve marcação, e um recado de WhatsApp
    // dentro de moldura corporativa soa falso.
    expect(email.sent[0]?.html).toBeNull()
  })

  it('AC-03: nenhuma informação vive só dentro da imagem', async () => {
    await enableMessaging(fixture)
    await givenBranding(fixture, { logoUrl: 'https://cdn.test/logo.png' })

    await sendSystemText()

    const html = email.sent[0]?.html ?? ''
    // O cliente que bloqueia imagem externa — que é o padrão de boa parte deles —
    // continua sabendo de quem é o e-mail.
    expect(html).toContain('alt="Petshop Teste"')
    expect(email.sent[0]?.body).toContain('Petshop Teste')
  })

  it('AC-04: tenant sem identidade visual cai no padrão, sem imagem quebrada', async () => {
    await enableMessaging(fixture)

    await sendSystemText()

    const html = email.sent[0]?.html ?? ''
    expect(html).not.toContain('<img')
    expect(html).toContain('Petshop Teste')
  })

  it('AC-05: nome com caractere de marcação aparece literal', async () => {
    await enableMessaging(fixture)
    await withTenant(fixture.tenantId, (tx) =>
      tx.tenant.update({ where: { id: fixture.tenantId }, data: { name: 'Ana & Cia <ME>' } }),
    )

    await sendSystemText()

    const html = email.sent[0]?.html ?? ''
    expect(html).toContain('Ana &amp; Cia &lt;ME&gt;')
    expect(html).not.toContain('<ME>')
  })

  it('o WhatsApp ignora o molde: lá o corpo é texto', async () => {
    await enableMessaging(fixture)
    await givenBranding(fixture, { logoUrl: 'https://cdn.test/logo.png' })
    const tutorId = await givenTutor(fixture, { marketing: { whatsapp: true } })
    const { installFakeWhatsAppPort } = await import('./fixtures.js')
    const whatsapp = installFakeWhatsAppPort()

    await enqueue({
      tutorId,
      channel: 'WHATSAPP',
      templateKey: 'appointment_reminder',
      dedupeKey: 'wa-1',
    })
    await dispatchNow()

    expect(whatsapp.sent[0]?.html).toBeNull()
  })
})

// ─── O catálogo do produto ───────────────────────────────────────────────────

describe('os textos do produto não são editáveis', () => {
  it('a tela do CRM não os oferece', async () => {
    const app = await getApp()
    const response = await app.inject({
      method: 'GET',
      url: '/v1/messaging/templates',
      headers: asAdmin(),
    })

    const keys = response.json<{ data: { key: string }[] }>().data.map((row) => row.key)
    expect(keys).toContain('appointment_reminder')
    expect(keys).not.toContain('tenant_welcome')
    expect(keys).not.toContain('receipt_issued')
  })

  it('a rota endereçável recusa a edição', async () => {
    const app = await getApp()
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/messaging/templates/tenant_welcome/EMAIL',
      headers: asAdmin(),
      payload: { subject: 'Oi', body: 'texto qualquer', active: true },
    })

    // Sem esta guarda, o petshop poderia apagar o endereço do painel do próprio e-mail
    // de boas-vindas — e descobrir quando o funcionário seguinte não conseguisse entrar.
    expect(response.statusCode).toBe(409)
  })
})

// ─── Os endereços da instalação ──────────────────────────────────────────────

describe('AC-02 de MOD-NOTIF-08 — os endereços saem do ambiente', () => {
  it('os três links refletem a instalação, e o Admin sai por app.', async () => {
    const { adminUrlOf, portalUrlOf, siteUrlOf } = await import(
      '../../src/modules/messaging/attachments.js'
    )

    // Em desenvolvimento não há subdomínio por tenant, e tudo cai no host único; o que
    // o teste fixa é a **forma**, e que ela não é constante cravada.
    expect(siteUrlOf('petshop-do-joao')).toContain(process.env.APP_DOMAIN ?? 'localhost')
    expect(portalUrlOf('petshop-do-joao')).toMatch(/\/portal$/)
    expect(adminUrlOf()).toMatch(/\/dashboard$/)
  })

  it('o e-mail de boas-vindas leva os três', async () => {
    await enableMessaging(fixture)
    await sendSystemText()

    const body = email.sent[0]?.body ?? ''
    // O admin que acabou de terminar o wizard não sabe que existem três superfícies.
    expect(body).toMatch(/dashboard/)
    expect(body).toMatch(/\/portal/)
  })
})
