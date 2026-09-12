import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CLERK_WEBHOOK_SECRET,
  callClerkWebhook,
  closeHarness,
  givenClerkUser,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
} from './fixtures.js'

/**
 * MOD-IDENT-03 — a sincronização com o Clerk.
 *
 * **A assinatura é assinada de verdade**, e não dublada: ela é a única coisa que protege
 * a rota, que é pública por necessidade — o Clerk é um serviço na internet. Um teste que
 * contornasse a verificação não diria nada sobre o AC-02, que é o critério mais
 * importante da sub-feature.
 */

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
})

afterAll(closeHarness)

/** O payload de `user.updated` como o Clerk o manda. */
function userEvent(
  clerkUserId: string,
  email: string,
  options: {
    type?: string
    firstName?: string
    lastName?: string
    updatedAt?: number
    twoFactor?: boolean
  } = {},
) {
  return {
    type: options.type ?? 'user.updated',
    data: {
      id: clerkUserId,
      first_name: options.firstName ?? 'Maria',
      last_name: options.lastName ?? 'Souza',
      image_url: 'https://img.clerk.test/maria.png',
      two_factor_enabled: options.twoFactor ?? false,
      primary_email_address_id: 'idn_1',
      email_addresses: [{ id: 'idn_1', email_address: email }],
      updated_at: options.updatedAt ?? Date.now(),
    },
  }
}

describe('AC-01 — o espelho local acompanha o Clerk', () => {
  it('aplica user.updated e grava o carimbo da versão', async () => {
    const session = await givenTenant('sincroniza')
    const antes = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: session.clerkUserId },
    })

    const updatedAt = Date.now()
    const response = await callClerkWebhook(
      userEvent(session.clerkUserId, 'sincroniza@petshop.test', {
        firstName: 'Maria',
        lastName: 'Nome Novo',
        twoFactor: true,
        updatedAt,
      }),
    )

    expect(response.statusCode).toBe(204)

    const depois = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: session.clerkUserId },
    })
    expect(depois.fullName).toBe('Maria Nome Novo')
    expect(depois.fullName).not.toBe(antes.fullName)
    expect(depois.mfaEnabled).toBe(true)
    expect(depois.avatarUrl).toBe('https://img.clerk.test/maria.png')
    // RN-09: o carimbo é o `updated_at` do evento, não a hora em que ele chegou.
    expect(depois.clerkSyncedAt?.getTime()).toBe(updatedAt)

    const evento = await ownerPrisma.webhookEvent.findFirstOrThrow({
      where: { provider: 'clerk' },
    })
    expect(evento.status).toBe('PROCESSED')
    expect(evento.eventType).toBe('user.updated')
    expect(evento.processedAt).not.toBeNull()
  })

  it('cria o espelho de quem ainda não apareceu em requisição nenhuma', async () => {
    const clerkUserId = givenClerkUser('novo@petshop.test')

    const response = await callClerkWebhook(
      userEvent(clerkUserId, 'novo@petshop.test', { type: 'user.created' }),
    )

    expect(response.statusCode).toBe(204)
    const user = await ownerPrisma.user.findUniqueOrThrow({ where: { clerkUserId } })
    expect(user.fullName).toBe('Maria Souza')
  })

  it('ignora tipo que não tratamos, sem gravar linha nenhuma', async () => {
    const response = await callClerkWebhook({ type: 'session.created', data: { id: 'sess_1' } })

    expect(response.statusCode).toBe(204)
    // A tabela não é um log de tudo o que chega: `session.created` sozinho a encheria.
    expect(await ownerPrisma.webhookEvent.count()).toBe(0)
  })
})

describe('AC-02 — assinatura inválida', () => {
  it('recusa com 401 e registra em security_events, sem tocar no espelho', async () => {
    const session = await givenTenant('assinatura')

    const response = await callClerkWebhook(
      userEvent(session.clerkUserId, 'assinatura@petshop.test', { firstName: 'Invasor' }),
      { signature: 'v1,YWJj' },
    )

    expect(response.statusCode).toBe(401)
    const problem = response.json()
    expect(problem.code).toBe('ERR_IDENT_005')

    const user = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: session.clerkUserId },
    })
    expect(user.fullName).not.toBe('Invasor Souza')
    expect(await ownerPrisma.webhookEvent.count()).toBe(0)

    const evento = await ownerPrisma.securityEvent.findFirstOrThrow({
      where: { type: 'WEBHOOK_SIGNATURE_INVALID' },
    })
    // A assinatura era justamente o que diria de quem se trata.
    expect(evento.tenantId).toBeNull()
    expect(evento.targetEntity).toBe('clerk_webhook')
  })

  it('recusa carimbo fora da janela de cinco minutos, mesmo bem assinado', async () => {
    const session = await givenTenant('carimbo')

    const response = await callClerkWebhook(
      userEvent(session.clerkUserId, 'carimbo@petshop.test'),
      { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 },
    )

    expect(response.statusCode).toBe(401)
  })

  it('recusa assinatura de outro segredo', async () => {
    const session = await givenTenant('outrosegredo')

    const response = await callClerkWebhook(
      userEvent(session.clerkUserId, 'outrosegredo@petshop.test'),
      { secret: 'whsec_' + Buffer.from('segredo-errado').toString('base64') },
    )

    expect(response.statusCode).toBe(401)
    expect(CLERK_WEBHOOK_SECRET).not.toBe('whsec_' + Buffer.from('segredo-errado').toString('base64'))
  })
})

describe('AC-03 — repetido e fora de ordem', () => {
  it('não reaplica o mesmo svix-id', async () => {
    const session = await givenTenant('repetido')
    const id = 'msg_repetido'
    const evento = userEvent(session.clerkUserId, 'repetido@petshop.test', {
      lastName: 'Primeira',
      updatedAt: Date.now(),
    })

    expect((await callClerkWebhook(evento, { id })).statusCode).toBe(204)

    // A segunda entrega vem com conteúdo diferente de propósito: se ela fosse aplicada,
    // o nome mudaria — e é assim que se vê que a idempotência é da entrega, não do dado.
    const segunda = { ...evento, data: { ...evento.data, last_name: 'Segunda' } }
    expect((await callClerkWebhook(segunda, { id })).statusCode).toBe(204)

    const user = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: session.clerkUserId },
    })
    expect(user.fullName).toBe('Maria Primeira')
    expect(await ownerPrisma.webhookEvent.count({ where: { externalEventId: id } })).toBe(1)
  })

  it('descarta evento mais antigo que o espelho', async () => {
    const session = await givenTenant('foradeordem')
    const agora = Date.now()

    await callClerkWebhook(
      userEvent(session.clerkUserId, 'foradeordem@petshop.test', {
        lastName: 'Atual',
        updatedAt: agora,
      }),
    )
    const atrasado = await callClerkWebhook(
      userEvent(session.clerkUserId, 'foradeordem@petshop.test', {
        lastName: 'Velho',
        updatedAt: agora - 60_000,
      }),
    )

    expect(atrasado.statusCode).toBe(204)
    const user = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: session.clerkUserId },
    })
    expect(user.fullName).toBe('Maria Atual')

    const ignorado = await ownerPrisma.webhookEvent.findFirstOrThrow({
      where: { status: 'IGNORED' },
    })
    expect(ignorado.error).toBe('evento mais antigo que o espelho')
  })
})

describe('RN-12 — colisão de e-mail', () => {
  it('grava FAILED e responde 204, sem pedir reentrega', async () => {
    const primeiro = await givenTenant('colisaoum')
    const segundo = await givenTenant('colisaodois')

    // O segundo usuário passa a apontar para o e-mail do primeiro.
    const response = await callClerkWebhook(
      userEvent(segundo.clerkUserId, 'colisaoum@petshop.test'),
    )

    /**
     * 204, e não 500: insistir faria o Clerk reentregar para sempre um conflito que só
     * sai à mão. O que fica é a linha `FAILED`, que a regra `clerk_webhook_failing`
     * conta no painel da plataforma.
     */
    expect(response.statusCode).toBe(204)
    const evento = await ownerPrisma.webhookEvent.findFirstOrThrow({ where: { status: 'FAILED' } })
    expect(evento.error).toBe('e-mail já pertence a outro usuário')
    // A mensagem não carrega o endereço: a tabela é lida por quem não precisa dele.
    expect(evento.error).not.toContain('@')

    const dono = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: primeiro.clerkUserId },
    })
    expect(dono.id).not.toBe(segundo.userId)
  })
})

describe('user.deleted', () => {
  it('desabilita o usuário e suspende os vínculos ativos', async () => {
    const session = await givenTenant('apagado')

    const response = await callClerkWebhook({
      type: 'user.deleted',
      data: { id: session.clerkUserId, deleted: true },
    })

    expect(response.statusCode).toBe(204)
    const user = await ownerPrisma.user.findUniqueOrThrow({
      where: { clerkUserId: session.clerkUserId },
    })
    expect(user.status).toBe('DISABLED')

    const membership = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: session.membershipId },
    })
    // Suspende, não remove: o fato é do outro lado e a volta precisa existir.
    expect(membership.status).toBe('SUSPENDED')
    // RN-03: quem está com token na mão precisa que o gateway detecte a divergência.
    expect(membership.permVersion).toBeGreaterThan(1)

    const trilha = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'membership.suspended' },
    })
    expect(trilha.actorUserId).toBeNull()
  })

  it('ignora quem não tem espelho local', async () => {
    const response = await callClerkWebhook({
      type: 'user.deleted',
      data: { id: 'user_que_nunca_entrou', deleted: true },
    })

    expect(response.statusCode).toBe(204)
    const evento = await ownerPrisma.webhookEvent.findFirstOrThrow({ where: { status: 'IGNORED' } })
    expect(evento.error).toBe('usuário sem espelho local')
  })
})

describe('organizationMembership.deleted', () => {
  it('suspende só o vínculo do estabelecimento daquela Organization', async () => {
    const um = await givenTenant('orgum')
    const dois = await givenTenant('orgdois')

    // A mesma pessoa nos dois estabelecimentos: é o caso que a RN-01 permite e o que
    // torna a pergunta "qual vínculo?" não trivial.
    const segundoVinculo = await ownerPrisma.membership.create({
      data: {
        tenantId: dois.tenantId,
        userId: um.userId,
        roleKey: 'RECEPTIONIST',
        status: 'ACTIVE',
      },
    })

    const response = await callClerkWebhook({
      type: 'organizationMembership.deleted',
      data: {
        id: 'orgmem_1',
        organization: { id: dois.clerkOrgId },
        public_user_data: { user_id: um.clerkUserId },
      },
    })

    expect(response.statusCode).toBe(204)
    expect(
      (await ownerPrisma.membership.findUniqueOrThrow({ where: { id: segundoVinculo.id } })).status,
    ).toBe('SUSPENDED')
    expect(
      (await ownerPrisma.membership.findUniqueOrThrow({ where: { id: um.membershipId } })).status,
    ).toBe('ACTIVE')
  })

  it('ignora Organization sem tenant local — a órfã do painel do Clerk', async () => {
    const session = await givenTenant('orfa')

    const response = await callClerkWebhook({
      type: 'organizationMembership.deleted',
      data: {
        id: 'orgmem_2',
        organization: { id: 'org_que_nao_existe_aqui' },
        public_user_data: { user_id: session.clerkUserId },
      },
    })

    expect(response.statusCode).toBe(204)
    const evento = await ownerPrisma.webhookEvent.findFirstOrThrow({ where: { status: 'IGNORED' } })
    expect(evento.error).toBe('Organization sem tenant local')
  })
})
