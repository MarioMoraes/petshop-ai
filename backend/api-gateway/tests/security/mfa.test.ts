import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asRole,
  callApi,
  closeHarness,
  expireGrace,
  extendGrace,
  givenSecurityTenant,
  ownerPrisma,
  resetDatabase,
  withMfa,
} from './fixtures.js'

/** MOD-SEC-01, 02 e 03 — o segundo fator obrigatório para o administrador. */

beforeEach(resetDatabase)
afterAll(closeHarness)

/**
 * O veículo das escritas é `/v1/services`, do scheduling.
 *
 * De propósito uma rota **ainda encaminhada**: o gate roda em `resolveSession`, antes do
 * roteamento, e é isso que faz a exigência valer também para o que não migrou. Um teste
 * que só usasse rota de módulo não provaria essa parte.
 */
const ESCRITA = { method: 'POST', url: '/v1/services', payload: { name: 'Banho' } } as const
const LEITURA = { method: 'GET', url: '/v1/professionals' } as const

describe('MOD-SEC-02 — a exigência', () => {
  it('AC-01: administrador com segundo fator escreve normalmente', async () => {
    const fixture = await givenSecurityTenant('comfa')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, true), ...ESCRITA })
    expect(response.statusCode).toBe(200)
  })

  it('AC-02: sem segundo fator e com carência vencida, a escrita responde 423', async () => {
    const fixture = await givenSecurityTenant('semfa')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, false), ...ESCRITA })

    expect(response.statusCode).toBe(423)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const problem = response.json()
    expect(problem.code).toBe('ERR_SEC_001')
    expect(problem.detail).toContain('verificação em duas etapas')
    // O frontend decide a tela por este campo, e não por interpretar a mensagem.
    expect(problem.mfaEnrollmentRequired).toBe(true)
  })

  it('AC-03: a leitura continua liberada', async () => {
    const fixture = await givenSecurityTenant('leitura')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, false), ...LEITURA })
    expect(response.statusCode).toBe(200)
  })

  it('AC-04: `/v1/me` responde 200 e diz o que falta', async () => {
    const fixture = await givenSecurityTenant('meupainel')
    await expireGrace(fixture)

    const response = await callApi({
      ...withMfa(fixture.admin, false),
      method: 'GET',
      url: '/v1/me',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().mfa).toMatchObject({ required: true, enabled: false })
    expect(response.json().mfa.graceEndsAt).toBeTruthy()
  })

  it('AC-05: papel não administrativo não é afetado', async () => {
    const fixture = await givenSecurityTenant('recepcao')
    const receptionist = await asRole(fixture, 'RECEPTIONIST')

    const response = await callApi({ ...withMfa(receptionist, false), ...ESCRITA })
    expect(response.statusCode).toBe(200)
  })

  it('AC-06: a recusa vira evento de segurança, e não linha de auditoria', async () => {
    const fixture = await givenSecurityTenant('evento')
    await expireGrace(fixture)

    await callApi({ ...withMfa(fixture.admin, false), ...ESCRITA })

    const evento = await ownerPrisma.securityEvent.findFirst({
      where: { tenantId: fixture.tenantId, type: 'MFA_REQUIRED' },
    })
    expect(evento).toBeTruthy()
    expect(evento?.actorUserId).toBe(fixture.adminUserId)

    /**
     * A trilha de auditoria registra o que **mudou**, e aqui nada mudou. Um admin sem
     * MFA clicando pela tela encheria `audit_logs` de ruído e empurraria o expurgo para
     * cima — padrão de tentativa mora em `security_events`.
     */
    expect(await ownerPrisma.auditLog.count({ where: { tenantId: fixture.tenantId } })).toBe(0)
  })
})

describe('MOD-SEC-01 — o claim', () => {
  /**
   * AC-02: template do Clerk sem o claim é erro de operação, não tentativa de burlar.
   * Tratar "não sei" como "não tem" transformaria um deploy com template desatualizado
   * em indisponibilidade total do Admin, sem nada no corpo que explicasse por quê.
   */
  it('AC-02: claim ausente libera, em vez de barrar', async () => {
    const fixture = await givenSecurityTenant('semclaim')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, null), ...ESCRITA })
    expect(response.statusCode).toBe(200)

    // E não finge que a pessoa tem segundo fator.
    const me = await callApi({ ...withMfa(fixture.admin, null), method: 'GET', url: '/v1/me' })
    expect(me.json().mfa).toMatchObject({ required: false, enabled: false })
  })
})

describe('MOD-SEC-03 — a carência', () => {
  it('AC-03: dentro do prazo, escreve e avisa', async () => {
    const fixture = await givenSecurityTenant('carencia')
    await extendGrace(fixture)

    const escrita = await callApi({ ...withMfa(fixture.admin, false), ...ESCRITA })
    expect(escrita.statusCode).toBe(200)

    const me = await callApi({ ...withMfa(fixture.admin, false), method: 'GET', url: '/v1/me' })
    expect(me.json().mfa.required).toBe(true)
    expect(new Date(me.json().mfa.graceEndsAt).getTime()).toBeGreaterThan(Date.now())
  })

  /**
   * AC-01 do backfill, visto pelo produto: um administrador **sem** prazo nenhum na
   * coluna é alguém que a migration não alcançou, e ele é barrado. É o comportamento
   * certo — a coluna nula quer dizer "sem prazo", não "prazo infinito".
   */
  it('sem prazo na coluna, a exigência vale imediatamente', async () => {
    const fixture = await givenSecurityTenant('semprazo')
    await ownerPrisma.membership.update({
      where: { id: fixture.adminMembershipId },
      data: { mfaGraceUntil: null },
    })

    const response = await callApi({ ...withMfa(fixture.admin, false), ...ESCRITA })
    expect(response.statusCode).toBe(423)
  })

  it('AC-05: ligar o segundo fator passa a valer sem esperar o prazo', async () => {
    const fixture = await givenSecurityTenant('ligou')
    await expireGrace(fixture)

    expect((await callApi({ ...withMfa(fixture.admin, false), ...ESCRITA })).statusCode).toBe(423)
    expect((await callApi({ ...withMfa(fixture.admin, true), ...ESCRITA })).statusCode).toBe(200)
  })
})

describe('MOD-SEC-03 — o prazo acompanha o papel', () => {
  it('AC-02: promover a administrador concede carência nova', async () => {
    const fixture = await givenSecurityTenant('promove')
    const other = await asRole(fixture, 'RECEPTIONIST')
    const membership = await ownerPrisma.membership.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, roleKey: 'RECEPTIONIST' },
    })
    expect(membership.mfaGraceUntil).toBeNull()

    const response = await callApi({
      ...fixture.admin,
      method: 'PATCH',
      url: `/v1/memberships/${membership.id}`,
      payload: { role: 'TENANT_ADMIN' },
    })
    expect(response.statusCode).toBe(200)

    const promoted = await ownerPrisma.membership.findUniqueOrThrow({ where: { id: membership.id } })
    expect(promoted.mfaGraceUntil).not.toBeNull()
    expect(promoted.mfaGraceUntil!.getTime()).toBeGreaterThan(Date.now())

    // E a pessoa promovida de fato passa, sem segundo fator, dentro do prazo.
    const escrita = await callApi({ ...withMfa(other, false), ...ESCRITA })
    expect(escrita.statusCode).toBe(200)
  })

  it('AC-04: rebaixar devolve a coluna a nulo', async () => {
    const fixture = await givenSecurityTenant('rebaixa')
    const segundo = await asRole(fixture, 'TENANT_ADMIN')
    const membership = await ownerPrisma.membership.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, userId: { not: fixture.adminUserId } },
    })

    await callApi({
      ...fixture.admin,
      method: 'PATCH',
      url: `/v1/memberships/${membership.id}`,
      payload: { role: 'RECEPTIONIST' },
    })

    const rebaixado = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: membership.id },
    })
    expect(rebaixado.mfaGraceUntil).toBeNull()

    // E deixa de ser exigido, mesmo sem segundo fator e sem prazo.
    expect((await callApi({ ...withMfa(segundo, false), ...ESCRITA })).statusCode).toBe(200)
  })
})
