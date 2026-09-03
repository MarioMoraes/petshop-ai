import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PORTAL_CHALLENGE_RATE, PORTAL_MAX_ATTEMPTS } from '@petshop/shared-types'
import {
  asTutor,
  asVisitor,
  callApi,
  captureMessages,
  closeHarness,
  givenTenant,
  givenTutor,
  givenUser,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/** MOD-PORTAL-01 e 11 — a porta do Portal. */

const TELEFONE = '+5511987654321'

let tenant: TenantFixture
let messages: ReturnType<typeof captureMessages>

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  messages = captureMessages()
})

afterAll(closeHarness)

async function pedirCodigo(identifier: string, extra: Record<string, unknown> = {}) {
  return callApi({
    ...asVisitor(tenant),
    method: 'POST',
    url: '/portal/v1/access/challenge',
    payload: { identifier, ...extra },
  })
}

describe('AC-01 e AC-03 — a resposta é a mesma para quem é e para quem não é cliente', () => {
  it('encontra a ficha pelo telefone e manda o código', async () => {
    const tutorId = await givenTutor(tenant, { phone: TELEFONE })

    const response = await pedirCodigo(TELEFONE)

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.channel).toBe('WHATSAPP')
    expect(body.expiresInMin).toBe(10)
    expect(messages.codes).toHaveLength(1)
    expect(messages.codes[0]?.tutorId).toBe(tutorId)
    expect(messages.codes[0]?.code).toMatch(/^\d{6}$/)
  })

  it('aceita o telefone digitado como a pessoa fala, e não em E.164', async () => {
    // O tutor digita "(11) 98765-4321"; o hash foi calculado sobre `+5511987654321`.
    // Sem a normalização, a ficha existente responderia como inexistente — o modo de
    // falha invisível deste módulo.
    await givenTutor(tenant, { phone: TELEFONE })

    await pedirCodigo('(11) 98765-4321')

    expect(messages.codes).toHaveLength(1)
  })

  it('encontra pelo e-mail, normalizando caixa e espaço', async () => {
    await givenTutor(tenant, { email: 'maria@exemplo.com' })

    const response = await pedirCodigo('  MARIA@Exemplo.com ')

    expect(response.statusCode).toBe(202)
    expect(response.json().channel).toBe('EMAIL')
    expect(messages.codes).toHaveLength(1)
  })

  it('responde igual para identificador desconhecido, e não manda nada', async () => {
    const conhecido = await pedirCodigo('nao-existe@exemplo.com')

    expect(conhecido.statusCode).toBe(202)
    const body = conhecido.json()
    // A **forma** é o que não pode variar: mesmos campos, todos preenchidos.
    expect(Object.keys(body).sort()).toEqual([
      'challengeId',
      'channel',
      'expiresInMin',
      'maskedTarget',
    ])
    expect(body.maskedTarget).toMatch(/^n\*+@exemplo\.com$/)
    expect(messages.codes).toHaveLength(0)
  })

  it('grava a linha mesmo sem ficha correspondente, para o rate limit contar', async () => {
    await pedirCodigo('ninguem@exemplo.com')

    const rows = await ownerPrisma.portalLinkChallenge.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tutorId).toBeNull()
  })

  it('AC-07: ficha anonimizada se comporta como inexistente', async () => {
    await givenTutor(tenant, { phone: TELEFONE, anonymized: true })

    const response = await pedirCodigo(TELEFONE)

    expect(response.statusCode).toBe(202)
    expect(messages.codes).toHaveLength(0)
  })
})

describe('AC-02 de MOD-PORTAL-11 — honeypot', () => {
  it('responde 202 e não faz nada quando o campo oculto vem preenchido', async () => {
    await givenTutor(tenant, { phone: TELEFONE })

    const response = await pedirCodigo(TELEFONE, { website: 'http://spam' })

    // A resposta é a do sucesso: um erro aqui ensinaria o bot a contornar.
    expect(response.statusCode).toBe(202)
    expect(Object.keys(response.json()).sort()).toEqual([
      'challengeId',
      'channel',
      'expiresInMin',
      'maskedTarget',
    ])
    expect(messages.codes).toHaveLength(0)

    // E nada é gravado: o balde de rate limit não é gasto por um robô.
    expect(await ownerPrisma.portalLinkChallenge.count()).toBe(0)
  })
})

describe('AC-01 de MOD-PORTAL-11 — rate limit', () => {
  it('o quarto pedido do mesmo identificador é 429', async () => {
    await givenTutor(tenant, { phone: TELEFONE })

    for (let i = 0; i < PORTAL_CHALLENGE_RATE.perIdentifier.max; i += 1) {
      expect((await pedirCodigo(TELEFONE)).statusCode).toBe(202)
    }

    const barrado = await pedirCodigo(TELEFONE)
    expect(barrado.statusCode).toBe(429)
    expect(barrado.json().code).toBe('ERR_PORTAL_004')
  })
})

describe('AC-02 — o vínculo nasce', () => {
  it('o código certo grava portal_user_id e devolve o contexto', async () => {
    const tutorId = await givenTutor(tenant, { phone: TELEFONE, name: 'Maria Souza' })
    const desafio = (await pedirCodigo(TELEFONE)).json()

    const response = await callApi({
      ...asVisitor(tenant),
      method: 'POST',
      url: '/portal/v1/access/verify',
      payload: { challengeId: desafio.challengeId, code: messages.codes[0]?.code },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().tutor).toMatchObject({ id: tutorId, name: 'Maria Souza' })

    const row = await ownerPrisma.tutor.findUniqueOrThrow({ where: { id: tutorId } })
    expect(row.portalUserId).toBe(tenant.userId)
    expect(row.portalLinkedAt).not.toBeNull()
    expect(messages.welcomes).toEqual([tutorId])
  })

  it('o desafio é de uso único', async () => {
    await givenTutor(tenant, { phone: TELEFONE })
    const desafio = (await pedirCodigo(TELEFONE)).json()
    const code = messages.codes[0]?.code

    await callApi({
      ...asVisitor(tenant),
      method: 'POST',
      url: '/portal/v1/access/verify',
      payload: { challengeId: desafio.challengeId, code },
    })

    const segunda = await callApi({
      ...asVisitor(tenant),
      method: 'POST',
      url: '/portal/v1/access/verify',
      payload: { challengeId: desafio.challengeId, code },
    })
    expect(segunda.statusCode).toBe(422)
  })

  it('recusa o desafio pedido por outra conta do Clerk', async () => {
    // Um código interceptado não pode valer para quem o interceptou.
    await givenTutor(tenant, { phone: TELEFONE })
    const desafio = (await pedirCodigo(TELEFONE)).json()

    const response = await callApi({
      clerkUserId: 'user_intruso',
      userId: await givenUser('intruso'),
      tenantId: tenant.tenantId,
      method: 'POST',
      url: '/portal/v1/access/verify',
      payload: { challengeId: desafio.challengeId, code: messages.codes[0]?.code },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PORTAL_002')
  })
})

describe('AC-05 — força bruta no código', () => {
  it('cinco erros bloqueiam o desafio e o sexto é 429', async () => {
    await givenTutor(tenant, { phone: TELEFONE })
    const desafio = (await pedirCodigo(TELEFONE)).json()

    // Um código garantidamente diferente do enviado: cravar '000000' faria o teste
    // falhar uma vez em um milhão, e essa é a pior frequência possível de falha.
    const enviado = messages.codes[0]?.code
    const errado = enviado === '000000' ? '111111' : '000000'

    const errar = () =>
      callApi({
        ...asVisitor(tenant),
        method: 'POST',
        url: '/portal/v1/access/verify',
        payload: { challengeId: desafio.challengeId, code: errado },
      })

    for (let i = 0; i < PORTAL_MAX_ATTEMPTS - 1; i += 1) {
      expect((await errar()).statusCode).toBe(422)
    }

    const ultima = await errar()
    expect(ultima.statusCode).toBe(429)
    expect(ultima.json().code).toBe('ERR_PORTAL_004')

    const row = await ownerPrisma.portalLinkChallenge.findUniqueOrThrow({
      where: { id: desafio.challengeId },
    })
    expect(row.blocked).toBe(true)
    expect(row.consumedAt).not.toBeNull()

    // O cooldown é do **identificador**: pedir um código novo não zera a contagem.
    const novoPedido = await pedirCodigo(TELEFONE)
    expect(novoPedido.statusCode).toBe(429)
  })
})

describe('AC-04 — ficha já vinculada a outra conta', () => {
  it('não manda código e o verify responde 409, sem dizer para quem', async () => {
    const outroUsuario = await givenUser('dono')
    await givenTutor(tenant, { phone: TELEFONE, portalUserId: outroUsuario })

    const desafio = (await pedirCodigo(TELEFONE)).json()
    expect(desafio.challengeId).toBeTruthy()
    // Nada é enviado: o 409 vem no verify, e avisar o dono legítimo de uma tentativa
    // que não vai a lugar nenhum só gastaria mensagem.
    expect(messages.codes).toHaveLength(0)
  })

  it('recusa com 409 quando o código chega a ser adivinhado', async () => {
    // O caminho é montado à mão porque, por desenho, não existe código enviado neste
    // cenário — o que se exercita aqui é a recusa do vínculo, não a do código.
    const tutorId = await givenTutor(tenant, { phone: TELEFONE })
    const desafio = (await pedirCodigo(TELEFONE)).json()
    expect(messages.codes).toHaveLength(1)

    await ownerPrisma.tutor.update({
      where: { id: tutorId },
      data: { portalUserId: await givenUser('dono') },
    })

    const response = await callApi({
      ...asVisitor(tenant),
      method: 'POST',
      url: '/portal/v1/access/verify',
      payload: { challengeId: desafio.challengeId, code: messages.codes[0]?.code },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PORTAL_003')
  })
})

describe('AC-06 — o mesmo telefone em duas fichas', () => {
  it('manda o código, e recusa o vínculo com 409 depois de provada a posse', async () => {
    await givenTutor(tenant, { phone: TELEFONE, name: 'Marido' })
    await givenTutor(tenant, { phone: TELEFONE, name: 'Esposa' })

    const desafio = (await pedirCodigo(TELEFONE)).json()
    // O código sai assim mesmo: as duas fichas compartilham o aparelho. É o que mantém
    // o 409 atrás de uma prova de posse, em vez de virar oráculo de "este número está
    // em duas fichas deste petshop".
    expect(messages.codes).toHaveLength(1)

    const response = await callApi({
      ...asVisitor(tenant),
      method: 'POST',
      url: '/portal/v1/access/verify',
      payload: { challengeId: desafio.challengeId, code: messages.codes[0]?.code },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PORTAL_005')

    const vinculadas = await ownerPrisma.tutor.count({ where: { portalUserId: { not: null } } })
    expect(vinculadas).toBe(0)
  })
})

describe('GET /portal/v1/me — o contexto do tutor', () => {
  it('devolve tutor, petshop e as chaves de funcionalidade', async () => {
    const tutorId = await givenTutor(tenant, { name: 'Maria Souza' })

    const response = await callApi({
      ...asTutor(tenant, tutorId),
      method: 'GET',
      url: '/portal/v1/me',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.tutor).toMatchObject({ id: tutorId, name: 'Maria Souza', balanceCents: 0 })
    expect(body.tenant.slug).toBe(tenant.slug)
    expect(body.features).toMatchObject({ portalEnabled: true, taxiEnabled: false })
  })

  it('AC-05 de MOD-PORTAL-02: sessão sem ficha vinculada é 401', async () => {
    const response = await callApi({
      ...asVisitor(tenant),
      method: 'GET',
      url: '/portal/v1/me',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('ERR_PORTAL_006')
  })

  it('RN-15: Portal desligado no tenant responde 403', async () => {
    const desligado = await givenTenant({ portalEnabled: false })
    const tutorId = await givenTutor(desligado)

    const response = await callApi({
      ...asTutor(desligado, tutorId),
      method: 'GET',
      url: '/portal/v1/me',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PORTAL_008')
  })
})

describe('GET /portal/v1/tenant — a tela de login', () => {
  it('devolve a identidade visual sem exigir tutor', async () => {
    const response = await callApi({
      clerkUserId: `anon:${tenant.slug}`,
      tenantId: tenant.tenantId,
      method: 'GET',
      url: '/portal/v1/tenant',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      name: 'Petshop do João',
      slug: tenant.slug,
      brandColor: '#2E7D32',
      portalEnabled: true,
    })
  })
})
