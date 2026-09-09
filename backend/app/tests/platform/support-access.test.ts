import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asRole,
  callApi,
  callPlatform,
  callSupport,
  closeHarness,
  givenPlatformAdmin,
  givenTenantWithAdmin,
  ownerPrisma,
  resetDatabase,
  seedTenant,
  type PlatformUser,
  type TenantWithAdmin,
} from './fixtures.js'

/** MOD-ADMIN-02 — o acesso de suporte consentido. */

let suporte: PlatformUser
let petshop: TenantWithAdmin

const MOTIVO = 'chamado #482 — tutor relata recibo não recebido'

beforeEach(async () => {
  await resetDatabase()
  suporte = await givenPlatformAdmin('Bruno do Suporte')
  petshop = await givenTenantWithAdmin('petshop-do-joao')
})

/** Pede e aprova, que é o par que quase todo caso precisa antes de começar. */
async function comAcessoAtivo(horas = 24): Promise<string> {
  const pedido = await callPlatform({
    method: 'POST',
    url: `/platform/v1/tenants/${petshop.tenantId}/support-access`,
    user: suporte,
    payload: { reason: MOTIVO },
  })
  const grantId = pedido.json().id as string

  await callApi({
    ...petshop.admin,
    method: 'POST',
    url: `/v1/support-access/${grantId}/approve`,
    payload: { hours: horas },
  })

  return grantId
}

afterAll(closeHarness)

describe('MOD-ADMIN-02 — pedir e autorizar', () => {
  it('AC-01: o pedido nasce em REQUESTED, sem prazo, e entra na trilha do estabelecimento', async () => {
    const response = await callPlatform({
      method: 'POST',
      url: `/platform/v1/tenants/${petshop.tenantId}/support-access`,
      user: suporte,
      payload: { reason: MOTIVO },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      status: 'REQUESTED',
      reason: MOTIVO,
      expiresAt: null,
    })
    expect(response.json().requestedBy.fullName).toBe('Bruno do Suporte')

    /**
     * A trilha é **do tenant**, e não da plataforma: quem precisa saber que alguém de fora
     * pediu acesso à base dele é ele. A tela de auditoria do MOD-SEC-05 já a mostra.
     */
    const linha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: petshop.tenantId, action: 'support.requested' },
    })
    expect(linha).not.toBeNull()
    expect(linha?.actorUserId).toBe(suporte.userId)
  })

  it('o motivo tem mínimo, porque é o que o petshop lê para decidir', async () => {
    const response = await callPlatform({
      method: 'POST',
      url: `/platform/v1/tenants/${petshop.tenantId}/support-access`,
      user: suporte,
      payload: { reason: 'suporte' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('AC-02: a aprovação define o prazo, e o grant vira ACTIVE', async () => {
    const grantId = await comAcessoAtivo(6)

    const grant = await ownerPrisma.supportAccessGrant.findUniqueOrThrow({
      where: { id: grantId },
    })
    expect(grant.status).toBe('ACTIVE')
    expect(grant.approvedBy).toBe(petshop.adminUserId)
    expect(grant.expiresAt).not.toBeNull()

    const horas = (grant.expiresAt!.getTime() - Date.now()) / 3_600_000
    expect(horas).toBeGreaterThan(5.9)
    expect(horas).toBeLessThan(6.1)
  })

  /**
   * O teto é do servidor, e o estabelecimento pode encurtar mas nunca esticar.
   *
   * Um prazo que o cliente escolhe sem teto é um grant permanente com outro nome — e a
   * decisão de quanto é demais não pode ser de quem está pedindo o acesso.
   */
  it('o prazo acima do teto é recusado', async () => {
    const pedido = await callPlatform({
      method: 'POST',
      url: `/platform/v1/tenants/${petshop.tenantId}/support-access`,
      user: suporte,
      payload: { reason: MOTIVO },
    })

    const response = await callApi({
      ...petshop.admin,
      method: 'POST',
      url: `/v1/support-access/${pedido.json().id}/approve`,
      payload: { hours: 150 },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('72')
  })

  it('pedir de novo enquanto o primeiro espera é recusado', async () => {
    const payload = { reason: MOTIVO }
    const url = `/platform/v1/tenants/${petshop.tenantId}/support-access`

    await callPlatform({ method: 'POST', url, user: suporte, payload })
    const segundo = await callPlatform({ method: 'POST', url, user: suporte, payload })

    expect(segundo.statusCode).toBe(409)
    expect(segundo.json().code).toBe('ERR_ADMIN_006')
  })

  it('quem opera o balcão vê os acessos, mas não os autoriza', async () => {
    const pedido = await callPlatform({
      method: 'POST',
      url: `/platform/v1/tenants/${petshop.tenantId}/support-access`,
      user: suporte,
      payload: { reason: MOTIVO },
    })
    const recepcao = await asRole(petshop, 'RECEPTIONIST')

    const leitura = await callApi({ ...recepcao, method: 'GET', url: '/v1/support-access' })
    expect(leitura.statusCode).toBe(200)
    expect(leitura.json().items).toHaveLength(1)

    const escrita = await callApi({
      ...recepcao,
      method: 'POST',
      url: `/v1/support-access/${pedido.json().id}/approve`,
      payload: { hours: 24 },
    })
    expect(escrita.statusCode).toBe(403)
  })
})

describe('MOD-ADMIN-02 — o que o grant abre e o que não abre', () => {
  /**
   * AC-03 — sem grant, nenhuma linha de negócio é lida.
   *
   * 403 e não 404: quem chegou aqui **é** da plataforma, e o que falta é o consentimento
   * do controlador. O corpo traz o caminho para pedi-lo.
   */
  it('AC-03: sem grant, a leitura é recusada com o caminho para pedir', async () => {
    const response = await callSupport({
      url: '/v1/tutors',
      user: suporte,
      tenantId: petshop.tenantId,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_ADMIN_002')
    expect(response.json().grantPath).toContain(petshop.tenantId)
  })

  it('com grant vivo, o suporte lê a mesma rota que a equipe do petshop usa', async () => {
    await comAcessoAtivo()

    const response = await callSupport({
      url: '/v1/tutors',
      user: suporte,
      tenantId: petshop.tenantId,
    })

    expect(response.statusCode).toBe(200)
  })

  /**
   * AC-07 — o grant é de **leitura**, e a recusa é na porta.
   *
   * Suporte que precisa corrigir dado pede ao estabelecimento que corrija. Um terceiro
   * escrevendo na ficha do cliente é indefensável na primeira reclamação.
   */
  it('AC-07: com grant vivo, qualquer escrita é recusada', async () => {
    await comAcessoAtivo()

    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await callSupport({
        method,
        url: '/v1/tutors',
        user: suporte,
        tenantId: petshop.tenantId,
        payload: { fullName: 'Intruso', phone: '11999998888' },
      })

      expect(response.statusCode, `${method} deveria ser recusado`).toBe(403)
      expect(response.json().code).toBe('ERR_ADMIN_003')
    }

    // E nada foi criado.
    const tutores = await ownerPrisma.tutor.count({ where: { tenantId: petshop.tenantId } })
    expect(tutores).toBe(0)
  })

  /**
   * AC-06 — toda leitura sob grant vira uma linha na trilha do estabelecimento.
   *
   * É o que torna o acesso verificável pelo lado de quem autorizou; sem isso, o grant seria
   * uma promessa sem prova.
   */
  it('AC-06: a leitura sob grant entra na trilha do estabelecimento, com o grant', async () => {
    const grantId = await comAcessoAtivo()

    await callSupport({ url: '/v1/tutors', user: suporte, tenantId: petshop.tenantId })
    // A linha é gravada fora do caminho da resposta; o teste espera a transação dela.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const linha = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: petshop.tenantId, action: 'support.read' },
    })
    expect(linha).not.toBeNull()
    expect(linha?.actorUserId).toBe(suporte.userId)
    expect((linha?.after as { grantId?: string })?.grantId).toBe(grantId)
  })

  /**
   * AC-04 — a expiração é conferida na leitura, e não por varredura.
   *
   * Um grant que vence enquanto a tela está aberta para de valer na ação seguinte; esperar
   * um job daria minutos de acesso depois do prazo.
   */
  it('AC-04: grant vencido para de valer na requisição seguinte', async () => {
    const grantId = await comAcessoAtivo()
    await ownerPrisma.supportAccessGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    const response = await callSupport({
      url: '/v1/tutors',
      user: suporte,
      tenantId: petshop.tenantId,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_ADMIN_002')
  })

  /** AC-05 — a revogação vale no clique, porque não há cache no caminho. */
  it('AC-05: revogado pelo estabelecimento, o acesso para na hora', async () => {
    const grantId = await comAcessoAtivo()

    const antes = await callSupport({ url: '/v1/tutors', user: suporte, tenantId: petshop.tenantId })
    expect(antes.statusCode).toBe(200)

    await callApi({
      ...petshop.admin,
      method: 'POST',
      url: `/v1/support-access/${grantId}/revoke`,
    })

    const depois = await callSupport({ url: '/v1/tutors', user: suporte, tenantId: petshop.tenantId })
    expect(depois.statusCode).toBe(403)
  })

  it('o grant de um estabelecimento não abre outro', async () => {
    await comAcessoAtivo()
    const outro = await seedTenant('petshop-alheio')

    const response = await callSupport({
      url: '/v1/tutors',
      user: suporte,
      tenantId: outro.tenantId,
    })

    expect(response.statusCode).toBe(403)
  })

  /**
   * O header sozinho não é nada.
   *
   * Quem não é da plataforma e forja `x-petshop-acting-tenant` recebe 404, como em toda a
   * superfície de plataforma: o header é um **pedido** de contexto, e a autorização é o
   * estabelecimento que a concede.
   */
  it('quem não é da plataforma não alcança nada forjando o header', async () => {
    const estranho = await asRole(petshop, 'RECEPTIONIST')
    const outro = await seedTenant('petshop-vitima')

    const response = await callApi({
      ...estranho,
      method: 'GET',
      url: '/v1/tutors',
      headers: { 'x-petshop-acting-tenant': outro.tenantId },
    })

    // A sessão dele tem Organization, então o caminho de suporte nem é considerado: ele
    // continua sendo a recepção do petshop dele, e o header é ignorado.
    expect(response.statusCode).toBe(200)
    const tutores = response.json().data as unknown[]
    expect(tutores).toHaveLength(0)
  })

  it('a recusa do pedido impede o acesso', async () => {
    const pedido = await callPlatform({
      method: 'POST',
      url: `/platform/v1/tenants/${petshop.tenantId}/support-access`,
      user: suporte,
      payload: { reason: MOTIVO },
    })

    await callApi({
      ...petshop.admin,
      method: 'POST',
      url: `/v1/support-access/${pedido.json().id}/deny`,
    })

    const response = await callSupport({
      url: '/v1/tutors',
      user: suporte,
      tenantId: petshop.tenantId,
    })
    expect(response.statusCode).toBe(403)
  })
})
