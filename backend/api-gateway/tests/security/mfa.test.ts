import { randomUUID } from 'node:crypto'
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
 * O veículo das escritas continua sendo `/v1/services`, e o que ele prova mudou.
 *
 * Enquanto a agenda era outro processo, esta rota era **encaminhada**, e o teste
 * mostrava que o gate vale também para o que não migrou. Depois da fatia 9 não sobrou
 * nenhuma rota administrativa encaminhada, e a prova de que o gate roda **antes do
 * roteamento** passou a ser outra, mais direta: a resposta é 423 mesmo quando o corpo é
 * inválido. O 422 do módulo viria depois, e nunca chega a ser calculado.
 *
 * Por isso há dois corpos. `escrita()` monta um válido, com nome único — o módulo cria
 * de verdade, e dois casos no mesmo teste não colidem; `ESCRITA_INVALIDA` é o que separa
 * a porta do módulo.
 */
function escrita(nome = `Banho ${randomUUID().slice(0, 8)}`) {
  return {
    method: 'POST',
    url: '/v1/services',
    payload: { name: nome, category: 'BATH', baseDurationMin: 60 },
  } as const
}

const ESCRITA_INVALIDA = { method: 'POST', url: '/v1/services', payload: { name: 'x' } } as const
const LEITURA = { method: 'GET', url: '/v1/professionals' } as const

describe('MOD-SEC-02 — a exigência', () => {
  it('AC-01: administrador com segundo fator escreve normalmente', async () => {
    const fixture = await givenSecurityTenant('comfa')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, true), ...escrita() })
    expect(response.statusCode).toBe(201)
  })

  it('AC-02: sem segundo fator e com carência vencida, a escrita responde 423', async () => {
    const fixture = await givenSecurityTenant('semfa')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, false), ...escrita() })

    expect(response.statusCode).toBe(423)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const problem = response.json()
    expect(problem.code).toBe('ERR_SEC_001')
    expect(problem.detail).toContain('verificação em duas etapas')
    // O frontend decide a tela por este campo, e não por interpretar a mensagem.
    expect(problem.mfaEnrollmentRequired).toBe(true)
  })

  /**
   * O gate roda **na porta**, e não no módulo — e é este caso que mostra.
   *
   * O corpo não passa na validação do catálogo da agenda, e mesmo assim a resposta é
   * 423, não 422: o hook de sessão decidiu antes de a requisição chegar ao roteador. Era
   * o que o encaminhamento provava enquanto a agenda era outro processo.
   */
  it('o gate decide antes do roteamento: corpo inválido responde 423, não 422', async () => {
    const fixture = await givenSecurityTenant('antesdarota')
    await expireGrace(fixture)

    const response = await callApi({ ...withMfa(fixture.admin, false), ...ESCRITA_INVALIDA })
    expect(response.statusCode).toBe(423)
    expect(response.json().code).toBe('ERR_SEC_001')
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

    const response = await callApi({ ...withMfa(receptionist, false), ...escrita() })

    /**
     * 403, e não 423: quem recusa é a **matriz** — `schedule:manage_catalog` é do
     * administrador —, e o gate de MFA deixou passar. É o que o AC pede, e a resposta
     * ainda prova mais que o 200 do eco que estava aqui antes da fatia 9: a requisição
     * chegou ao módulo, com o código do catálogo dele.
     */
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_AGENDA_003')
  })

  it('AC-06: a recusa vira evento de segurança, e não linha de auditoria', async () => {
    const fixture = await givenSecurityTenant('evento')
    await expireGrace(fixture)

    await callApi({ ...withMfa(fixture.admin, false), ...escrita() })

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

    const response = await callApi({ ...withMfa(fixture.admin, null), ...escrita() })
    expect(response.statusCode).toBe(201)

    // E não finge que a pessoa tem segundo fator.
    const me = await callApi({ ...withMfa(fixture.admin, null), method: 'GET', url: '/v1/me' })
    expect(me.json().mfa).toMatchObject({ required: false, enabled: false })
  })
})

describe('MOD-SEC-03 — a carência', () => {
  it('AC-03: dentro do prazo, escreve e avisa', async () => {
    const fixture = await givenSecurityTenant('carencia')
    await extendGrace(fixture)

    const resposta = await callApi({ ...withMfa(fixture.admin, false), ...escrita() })
    expect(resposta.statusCode).toBe(201)

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

    const response = await callApi({ ...withMfa(fixture.admin, false), ...escrita() })
    expect(response.statusCode).toBe(423)
  })

  it('AC-05: ligar o segundo fator passa a valer sem esperar o prazo', async () => {
    const fixture = await givenSecurityTenant('ligou')
    await expireGrace(fixture)

    expect((await callApi({ ...withMfa(fixture.admin, false), ...escrita() })).statusCode).toBe(423)
    expect((await callApi({ ...withMfa(fixture.admin, true), ...escrita() })).statusCode).toBe(201)
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

    // E a pessoa promovida de fato passa, sem segundo fator, dentro do prazo — agora
    // com `schedule:manage_catalog`, que o papel novo concede.
    const resposta = await callApi({ ...withMfa(other, false), ...escrita() })
    expect(resposta.statusCode).toBe(201)
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

    /**
     * E deixa de ser exigido, mesmo sem segundo fator e sem prazo: 403 da matriz, e não
     * 423 do gate. O papel novo é a recepção, que não mexe no catálogo.
     */
    const depois = await callApi({ ...withMfa(segundo, false), ...escrita() })
    expect(depois.statusCode).toBe(403)
    expect(depois.json().code).toBe('ERR_AGENDA_003')
  })
})
