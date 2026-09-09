import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  asStranger,
  callApi,
  closeHarness,
  fakeClerk,
  givenClerkUser,
  givenTenant,
  mailerState,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
  resetMailer,
  sentMails,
  type IdentityTenant,
} from './fixtures.js'

/**
 * MOD-IDENT-06 — convites de equipe: criar, reenviar, revogar e aceitar.
 *
 * **O convidado é um chamador sem Organization**, e é o que torna este módulo diferente
 * dos outros: as duas rotas do aceite existem justamente para quem ainda não é membro
 * de estabelecimento nenhum. `asStranger` é esse estado, e não a falta de um dado.
 */

async function invite(admin: IdentityTenant, email: string, role = 'GROOMER') {
  return callApi({
    method: 'POST',
    url: '/v1/invitations',
    payload: { email, role },
    ...asAdmin(admin),
  })
}

/** O token do link é o que o convidado tem em mãos — a URL é o único lugar onde ele existe. */
function tokenOf(inviteUrl: string): string {
  return inviteUrl.split('/convite/')[1] as string
}

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
  resetMailer()
})

afterAll(closeHarness)

describe('AC-01 — convite criado e enviado', () => {
  it('cria PENDING com 7 dias de prazo e enfileira o e-mail', async () => {
    const admin = await givenTenant('acme')

    const response = await invite(admin, 'tosador@exemplo.com')

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('PENDING')
    expect(body.roleKey).toBe('GROOMER')
    expect(body.roleLabel).toBe('Tosador')
    expect(body.email).toBe('tosador@exemplo.com')

    const dias = (new Date(body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(dias).toBeGreaterThan(6.9)
    expect(dias).toBeLessThan(7.1)

    expect(sentMails).toHaveLength(1)
    expect(sentMails[0]?.to).toBe('tosador@exemplo.com')
    expect(sentMails[0]?.inviteUrl).toBe(body.inviteUrl)
  })

  it('guarda apenas o hash do token — o link não é reconstruível a partir do banco', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()

    const row = await ownerPrisma.invitation.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.tokenHash).not.toContain(tokenOf(body.inviteUrl))
    expect(row.emailEncrypted).not.toContain('tosador@exemplo.com')
  })

  it('o convite sobrevive à queda do provedor de e-mail', async () => {
    const admin = await givenTenant('acme')
    mailerState.failing = true

    const response = await invite(admin, 'tosador@exemplo.com')

    // O link volta na resposta justamente para este caso: o admin o entrega à mão.
    expect(response.statusCode).toBe(201)
    expect(response.json().inviteUrl).toContain('/convite/')
  })

  it('recusa quem não tem `team:invite`', async () => {
    const admin = await givenTenant('acme')
    const response = await callApi({
      method: 'POST',
      url: '/v1/invitations',
      payload: { email: 'tosador@exemplo.com', role: 'GROOMER' },
      ...(await asRole(admin, 'RECEPTIONIST')),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_IDENT_003')
  })

  it('recusa papel que não é de equipe (RN-05)', async () => {
    const admin = await givenTenant('acme')
    const response = await invite(admin, 'tutor@exemplo.com', 'TUTOR')
    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_IDENT_002')
  })
})

describe('AC-02 — e-mail já é da equipe', () => {
  it('devolve 409 quando a pessoa já tem vínculo ativo', async () => {
    const admin = await givenTenant('acme')

    const response = await invite(admin, 'acme@petshop.test')

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_IDENT_004')
    expect(response.json().detail).toContain('já faz parte')
  })

  it('devolve 409 no segundo convite pendente para o mesmo e-mail', async () => {
    const admin = await givenTenant('acme')
    await invite(admin, 'tosador@exemplo.com')

    const response = await invite(admin, 'tosador@exemplo.com')

    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toContain('convite pendente')
  })
})

describe('AC-03 — expiração e limite de plano', () => {
  it('recusa com 410 o convite fora do prazo', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    await ownerPrisma.invitation.update({
      where: { id: body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const convidado = givenClerkUser('tosador@exemplo.com')
    const response = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(body.inviteUrl) },
      ...asStranger(convidado),
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().code).toBe('ERR_IDENT_006')
    const row = await ownerPrisma.invitation.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.status).toBe('EXPIRED')
  })

  it('recusa com 402 ao estourar os assentos do plano (RN-11)', async () => {
    const admin = await givenTenant('acme')

    // STARTER = 5 assentos. O admin já ocupa um; quatro convites fecham a conta.
    for (const nome of ['a', 'b', 'c', 'd']) {
      expect((await invite(admin, `${nome}@exemplo.com`)).statusCode).toBe(201)
    }

    const response = await invite(admin, 'e@exemplo.com')

    expect(response.statusCode).toBe(402)
    expect(response.json().code).toBe('ERR_IDENT_007')
    expect(response.json().detail).toContain('Starter')
  })

  it('convite pendente ocupa assento, e revogar devolve o lugar', async () => {
    const admin = await givenTenant('acme')
    const primeiro = (await invite(admin, 'a@exemplo.com')).json()
    for (const nome of ['b', 'c', 'd']) await invite(admin, `${nome}@exemplo.com`)
    expect((await invite(admin, 'e@exemplo.com')).statusCode).toBe(402)

    const revogado = await callApi({
      method: 'DELETE',
      url: `/v1/invitations/${primeiro.id}`,
      ...asAdmin(admin),
    })
    expect(revogado.statusCode).toBe(200)

    expect((await invite(admin, 'e@exemplo.com')).statusCode).toBe(201)
  })
})

describe('Aceite', () => {
  it('cria o membership, entra na Organization do Clerk e marca ACCEPTED', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    const convidado = givenClerkUser('tosador@exemplo.com', 'Ana Tosadora')

    const response = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(body.inviteUrl) },
      ...asStranger(convidado),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tenantId: admin.tenantId,
      roleKey: 'GROOMER',
      roleLabel: 'Tosador',
    })

    const user = await ownerPrisma.user.findFirstOrThrow({ where: { clerkUserId: convidado } })
    const membership = await ownerPrisma.membership.findFirstOrThrow({
      where: { tenantId: admin.tenantId, userId: user.id },
    })
    expect(membership.roleKey).toBe('GROOMER')
    expect(membership.status).toBe('ACTIVE')
    // RN-06: papel de operação vira profissional da agenda.
    expect(membership.isProfessional).toBe(true)

    // Sem isto o membership local seria invisível: o gateway resolve o tenant pelo
    // `org_id` do token do Clerk.
    expect(fakeClerk.organizationMembers.has(`${admin.clerkOrgId}:${convidado}`)).toBe(true)

    const row = await ownerPrisma.invitation.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.status).toBe('ACCEPTED')
    expect(row.acceptedAt).not.toBeNull()
  })

  it('semeia o permVersion do convidado no metadata do membership (RN-03)', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    const convidado = givenClerkUser('tosador@exemplo.com', 'Ana Tosadora')

    await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(body.inviteUrl) },
      ...asStranger(convidado),
    })

    // Sem o valor semeado aqui, o JWT template publica o claim como `null` e a
    // detecção de token com papel velho só passaria a valer depois da primeira troca
    // de papel — que é quando o MOD-IDENT-04 escreveria o metadata pela primeira vez.
    const user = await ownerPrisma.user.findFirstOrThrow({ where: { clerkUserId: convidado } })
    const membership = await ownerPrisma.membership.findFirstOrThrow({
      where: { tenantId: admin.tenantId, userId: user.id },
    })
    expect(fakeClerk.permVersions.get(`${admin.clerkOrgId}:${convidado}`)).toBe(
      membership.permVersion,
    )
  })

  it('recusa quem entrou com outro e-mail', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    const outro = givenClerkUser('outra.pessoa@exemplo.com')

    const response = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(body.inviteUrl) },
      ...asStranger(outro),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().detail).toContain('outro e-mail')
    const row = await ownerPrisma.invitation.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.status).toBe('PENDING')
  })

  it('recusa token inexistente sem revelar nada', async () => {
    await givenTenant('acme')
    const response = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: 'x'.repeat(43) },
      ...asStranger(givenClerkUser('ninguem@exemplo.com')),
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_IDENT_001')
  })

  it('é idempotente: uma falha do Clerk se conserta clicando de novo', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    const convidado = givenClerkUser('tosador@exemplo.com')
    const token = tokenOf(body.inviteUrl)

    fakeClerk.failAddOrganizationMembership = new Error('clerk fora do ar')
    const primeira = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token },
      ...asStranger(convidado),
    })
    expect(primeira.statusCode).toBe(500)
    // O vínculo local já está comitado — é a metade que deu certo.
    const user = await ownerPrisma.user.findFirstOrThrow({ where: { clerkUserId: convidado } })
    expect(
      await ownerPrisma.membership.count({ where: { tenantId: admin.tenantId, userId: user.id } }),
    ).toBe(1)

    fakeClerk.failAddOrganizationMembership = null
    const segunda = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token },
      ...asStranger(convidado),
    })

    expect(segunda.statusCode).toBe(200)
    expect(fakeClerk.organizationMembers.has(`${admin.clerkOrgId}:${convidado}`)).toBe(true)
    expect(
      await ownerPrisma.membership.count({ where: { tenantId: admin.tenantId, userId: user.id } }),
    ).toBe(1)
  })

  it('recusa convite revogado', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    await callApi({ method: 'DELETE', url: `/v1/invitations/${body.id}`, ...asAdmin(admin) })

    const response = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(body.inviteUrl) },
      ...asStranger(givenClerkUser('tosador@exemplo.com')),
    })

    expect(response.statusCode).toBe(410)
  })
})

describe('Reenvio e listagem', () => {
  it('reenviar troca o token: o link antigo para de valer', async () => {
    const admin = await givenTenant('acme')
    const primeiro = (await invite(admin, 'tosador@exemplo.com')).json()

    const segundo = await callApi({
      method: 'POST',
      url: `/v1/invitations/${primeiro.id}/resend`,
      ...asAdmin(admin),
    })
    expect(segundo.statusCode).toBe(200)
    expect(segundo.json().inviteUrl).not.toBe(primeiro.inviteUrl)
    expect(sentMails).toHaveLength(2)

    const convidado = givenClerkUser('tosador@exemplo.com')
    const comLinkAntigo = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(primeiro.inviteUrl) },
      ...asStranger(convidado),
    })
    expect(comLinkAntigo.statusCode).toBe(404)

    const comLinkNovo = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(segundo.json().inviteUrl) },
      ...asStranger(convidado),
    })
    expect(comLinkNovo.statusCode).toBe(200)
  })

  it('reenviar um pendente funciona mesmo com o plano lotado', async () => {
    const admin = await givenTenant('acme')
    const primeiro = (await invite(admin, 'a@exemplo.com')).json()
    for (const nome of ['b', 'c', 'd']) await invite(admin, `${nome}@exemplo.com`)
    // Assentos esgotados: o convite reenviado é um dos que já ocupam lugar.
    expect((await invite(admin, 'e@exemplo.com')).statusCode).toBe(402)

    const response = await callApi({
      method: 'POST',
      url: `/v1/invitations/${primeiro.id}/resend`,
      ...asAdmin(admin),
    })

    expect(response.statusCode).toBe(200)
  })

  it('reenviar ressuscita um convite vencido', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()
    await ownerPrisma.invitation.update({
      where: { id: body.id },
      data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) },
    })

    const response = await callApi({
      method: 'POST',
      url: `/v1/invitations/${body.id}/resend`,
      ...asAdmin(admin),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('PENDING')
  })

  it('lista os pendentes e esconde os já aceitos', async () => {
    const admin = await givenTenant('acme')
    const aceito = (await invite(admin, 'aceito@exemplo.com')).json()
    await invite(admin, 'pendente@exemplo.com', 'BATHER')
    await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: tokenOf(aceito.inviteUrl) },
      ...asStranger(givenClerkUser('aceito@exemplo.com')),
    })

    const response = await callApi({ method: 'GET', url: '/v1/invitations', ...asAdmin(admin) })

    expect(response.statusCode).toBe(200)
    const lista = response.json()
    expect(lista).toHaveLength(1)
    expect(lista[0].email).toBe('pendente@exemplo.com')
    expect(lista[0].roleLabel).toBe('Banhista')
    expect(lista[0].invitedByName).toBeTruthy()
    // O token nunca reaparece: quem perdeu o link pede reenvio.
    expect(lista[0].inviteUrl).toBeUndefined()
  })

  it('a prévia pública mascara o e-mail de quem foi convidado', async () => {
    const admin = await givenTenant('acme')
    const body = (await invite(admin, 'tosador@exemplo.com')).json()

    const response = await callApi({
      method: 'GET',
      url: `/v1/invitations/preview?token=${tokenOf(body.inviteUrl)}`,
      ...asStranger(givenClerkUser('quemquer@exemplo.com')),
    })

    expect(response.statusCode).toBe(200)
    const preview = response.json()
    expect(preview.tenantName).toBe('Petshop acme')
    expect(preview.roleLabel).toBe('Tosador')
    expect(preview.status).toBe('PENDING')
    expect(preview.maskedEmail).not.toContain('tosador@')
    expect(preview.maskedEmail).toContain('@exemplo.com')
  })
})

describe('Isolamento entre tenants (MOD-IDENT-07)', () => {
  it('um tenant não enxerga nem revoga convite do outro', async () => {
    const acme = await givenTenant('acme')
    const outro = await givenTenant('outro')
    const conviteDoOutro = (await invite(outro, 'alvo@exemplo.com')).json()

    const lista = await callApi({ method: 'GET', url: '/v1/invitations', ...asAdmin(acme) })
    expect(lista.json()).toHaveLength(0)

    const revogar = await callApi({
      method: 'DELETE',
      url: `/v1/invitations/${conviteDoOutro.id}`,
      ...asAdmin(acme),
    })
    // 404, nunca 403: não se revela que o convite existe noutro estabelecimento.
    expect(revogar.statusCode).toBe(404)
  })
})
