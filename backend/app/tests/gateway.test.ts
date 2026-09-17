import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SERVICE_HEADERS } from '@petshop/service-auth'
import {
  closeHarness,
  getApp,
  getGateway,
  givenToken,
  ownerPrisma,
  resetDatabase,
  seedMember,
  seedPortalTutor,
  seedTenant,
} from './harness.js'

/** O backend — autenticação, resolução de tenant e propagação de contexto. */

beforeEach(resetDatabase)
afterAll(closeHarness)

async function call(options: {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  url: string
  token?: string
  headers?: Record<string, string>
  payload?: unknown
}) {
  const app = await getGateway()
  return app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

describe('autenticação', () => {
  it('recusa requisição sem token', async () => {
    const response = await call({ url: '/v1/me' })
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json().code).toBe('ERR_IDENT_005')
  })

  it('recusa token desconhecido', async () => {
    const response = await call({ url: '/v1/me', token: 'tok_inexistente' })
    expect(response.statusCode).toBe(401)
    expect(response.json().detail).toBe('Sessão inválida ou expirada')
  })

  it('deixa /health passar sem token', async () => {
    const response = await call({ url: '/health' })
    expect(response.statusCode).toBe(200)
    // `petshop-app`, e não `api-gateway`: o processo deixou de ser só um gateway
    // quando passou a hospedar módulo. Ver a consolidação no CLAUDE.md.
    expect(response.json().service).toBe('petshop-app')
  })

  /**
   * A asserção que se inverteu onze vezes, e a última forma dela.
   *
   * A cada fatia da consolidação uma família de rota deixava de ser encaminhada, e o teste
   * correspondente virava do avesso: de "vai para o serviço X" para "não sai do processo".
   * Enquanto havia um serviço de destino, a prova era um eco que não recebia nada.
   *
   * Na fatia 11 o último destino sumiu e o eco com ele. O que sobrou é isto: **as onze
   * famílias respondem, aqui**. Um 404 com `ERR_IDENT_001` significaria que alguém apagou
   * uma rota junto com o encaminhamento dela — que é exatamente o acidente que o eco
   * denunciava.
   */
  it('as onze famílias de rota da consolidação são atendidas neste processo', async () => {
    const tenant = await seedTenant('rotatudo')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })
    const petId = '11111111-1111-4111-8111-111111111111'

    for (const url of [
      // MOD-IDENT (7), MOD-TUTOR (6), MOD-PET (5)
      '/v1/me',
      '/v1/roles',
      '/v1/memberships',
      '/v1/tutors?q=maria',
      '/v1/pets?q=thor',
      '/v1/species',
      '/v1/sizes',
      // MOD-PRONT (8) — sob o mesmo prefixo do pet, e era exceção por sufixo
      `/v1/pets/${petId}/alerts`,
      `/v1/pets/${petId}/timeline`,
      '/v1/attendances',
      // MOD-AGENDA (9)
      '/v1/services',
      '/v1/professionals',
      '/v1/availability',
      // MOD-LEDGER (10) — `/packages` era a última exceção por sufixo do `proxy.ts`
      '/v1/payments',
      '/v1/billing-settings',
      `/v1/tutors/${petId}/packages`,
      // MOD-SITE (1), MOD-TAXI (2), MOD-CRM (3), MOD-NOTIF (4), MOD-SEC (fase 7)
      '/v1/site/settings',
      '/v1/taxi/zones',
      '/v1/crm/automations',
      '/v1/messages',
      '/v1/audit-logs',
    ]) {
      const response = await call({ url, token })
      expect(
        response.json().code,
        `${url} respondeu como rota inexistente`,
      ).not.toBe('ERR_IDENT_001')
    }
  })

  it('o upload de foto é consumido aqui, com o arquivo inteiro', async () => {
    const tenant = await seedTenant('rotafoto')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const boundary = '----petshopteste123'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="thor.jpg"\r\n` +
          `Content-Type: image/jpeg\r\n\r\n`,
      ),
      // Bytes que não sobrevivem a um JSON.stringify — é justamente o ponto.
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    const response = await call({
      method: 'POST',
      url: `/v1/pets/${'11111111-1111-4111-8111-111111111111'}/photos`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })

    /**
     * O upload virou rota do módulo na fatia 5, com o `@fastify/multipart` do escopo dele.
     * O que se prova aqui é que o corpo binário **chega**: um 404 de pet inexistente ou um
     * 422 de imagem inválida significam que o parser leu o arquivo; um 400 de multipart
     * quebrado significaria que o parser errado o pegou.
     *
     * O parser bruto do `app.ts` — o que bufferizava o corpo byte a byte para repassá-lo
     * intacto ao serviço de destino — saiu na fatia 11 com o `proxy.ts`. Era ele que
     * disputava o `multipart/form-data` com o parser de verdade e obrigava os dois a viver
     * em escopos irmãos; sem ele, sobrou um parser só, e este teste é quem nota se o
     * escopo do módulo o perder.
     */
    expect([404, 422]).toContain(response.statusCode)
  })

  it('devolve 404 para rota que ninguém registrou', async () => {
    const token = givenToken({ clerkUserId: 'user_semrota' })
    const response = await call({ url: '/v1/inexistente', token })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_IDENT_001')
  })
})

/**
 * A resolução do contexto da sessão.
 *
 * **Esta suíte perdeu o veículo na fatia 9, e o que ela prova ficou mais forte.** Até
 * aqui ela chamava `/v1/professionals`, que era encaminhado, e inspecionava os headers
 * assinados no caminho — o que mostrava o contexto, mas não que alguém o obedecia. Sem
 * nenhuma rota administrativa saindo do processo, a prova passa a ser o **efeito**: o
 * papel que a matriz concede é o que a rota deixa fazer.
 *
 * A assinatura do contexto continua exercitada de ponta a ponta na suíte do Portal, que
 * é o último destino do `proxy.ts`.
 */
const SERVICO_VALIDO = { name: 'Banho Novo', category: 'BATH', baseDurationMin: 60 }

describe('resolução do contexto da sessão', () => {
  it('o papel resolvido é o que decide o que a rota deixa fazer', async () => {
    const tenant = await seedTenant('propaga')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({
      clerkUserId: member.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
      permVersion: 1,
    })

    // A recepção agenda o dia inteiro: `schedule:read_all` está na matriz do §9.
    const leitura = await call({ url: '/v1/services', token })
    expect(leitura.statusCode).toBe(200)

    // Mas não decide quanto custa um banho: `schedule:manage_catalog` é do admin.
    const escrita = await call({
      method: 'POST',
      url: '/v1/services',
      token,
      payload: SERVICO_VALIDO,
    })
    expect(escrita.statusCode).toBe(403)
    expect(escrita.json().code).toBe('ERR_AGENDA_003')
  })

  it('o mesmo token com papel de admin passa pela mesma rota', async () => {
    const tenant = await seedTenant('propagaadmin')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'POST',
      url: '/v1/services',
      token,
      payload: SERVICO_VALIDO,
    })
    expect(response.statusCode).toBe(201)
  })

  /**
   * AC-01 de MOD-SEC-07 — o cliente que se declara de outro estabelecimento.
   *
   * O `proxy.ts` descartava esses headers antes de encaminhar, e era isso que o teste
   * anterior conferia. Sem encaminhamento administrativo, o que resta provar é o que
   * sempre importou de verdade: **o contexto que vale é o que o gateway resolveu**, e a
   * tentativa deixa rastro em `security_events` em vez de sumir em silêncio.
   */
  it('o header de tenant forjado não muda o contexto e vira evento de segurança', async () => {
    const tenant = await seedTenant('forjado')
    const outro = await seedTenant('vitima')
    const member = await seedMember(tenant.tenantId, 'BATHER')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      url: '/v1/services',
      token,
      headers: {
        [SERVICE_HEADERS.tenantId]: outro.tenantId,
        [SERVICE_HEADERS.role]: 'TENANT_ADMIN',
        [SERVICE_HEADERS.permissions]: 'tutor:delete,schedule:manage_catalog',
      },
    })

    // O banhista não tem `schedule:read_all`: prevalece o papel que o gateway resolveu,
    // e não o que o cliente afirmou.
    expect(response.statusCode).toBe(403)

    const evento = await ownerPrisma.securityEvent.findFirst({
      where: { type: 'CROSS_TENANT_ATTEMPT', tenantId: tenant.tenantId },
    })
    expect(evento?.targetId).toBe(outro.tenantId)
  })

  it('quem não tem Organization ativa segue sem tenant, e a agenda recusa', async () => {
    const tenant = await seedTenant('semorg')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')

    // O token não traz Organization: é a sessão de quem ainda vai criar o primeiro
    // estabelecimento, ou de quem trocou de contexto no Clerk e ainda não escolheu um.
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: null })

    // Sem tenant não há de que agenda se fala — e o papel do outro tenant não vale.
    const agenda = await call({ url: '/v1/services', token })
    expect(agenda.statusCode).toBe(403)
  })
})

describe('AC-03 de MOD-IDENT-04 — papel alterado com sessão ativa', () => {
  it('aplica o papel novo mesmo com token trazendo permVersion antigo', async () => {
    const tenant = await seedTenant('rebaixa')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')

    // Token emitido quando o usuário ainda era admin.
    const token = givenToken({
      clerkUserId: member.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
      permVersion: 1,
    })

    const antes = await call({
      method: 'POST',
      url: '/v1/services',
      token,
      payload: SERVICO_VALIDO,
    })
    expect(antes.statusCode).toBe(201)

    // O admin rebaixa o usuário; permVersion vai para 2.
    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { roleKey: 'RECEPTIONIST', permVersion: 2 },
    })

    // Mesmo token de antes: o gateway detecta e aplica o papel novo.
    const depois = await call({
      method: 'POST',
      url: '/v1/services',
      token,
      payload: { ...SERVICO_VALIDO, name: 'Banho Rebaixado' },
    })
    expect(depois.statusCode).toBe(403)
    expect(depois.json().code).toBe('ERR_AGENDA_003')
  })

  it('não sobra permissão nenhuma quando o membership foi removido', async () => {
    const tenant = await seedTenant('removido')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { status: 'REMOVED' },
    })

    // Nem a leitura mais larga da agenda sobrevive: sem membership não há papel.
    const response = await call({ url: '/v1/services', token })
    expect(response.statusCode).toBe(403)
  })
})

describe('RN-04 — tenant suspenso', () => {
  it('bloqueia escrita com 423 ERR_IDENT_008', async () => {
    const tenant = await seedTenant('suspenso', 'SUSPENDED')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'POST',
      url: '/v1/services',
      token,
      payload: SERVICO_VALIDO,
    })

    // O gate do tenant suspenso roda no hook de sessão, **antes** do roteamento — e é
    // por isso que ele continua valendo igual depois de a rota virar módulo daqui.
    expect(response.statusCode).toBe(423)
    expect(response.json().code).toBe('ERR_IDENT_008')
    expect(response.json().detail).toContain('Regularize a assinatura')
  })

  it('mantém a leitura liberada, para consulta e exportação LGPD', async () => {
    const tenant = await seedTenant('suspensoleitura', 'SUSPENDED')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({ url: '/v1/professionals', token })
    expect(response.statusCode).toBe(200)
  })

  it('não bloqueia tenant ativo', async () => {
    const tenant = await seedTenant('ativo', 'ACTIVE')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'POST',
      url: '/v1/services',
      token,
      payload: SERVICO_VALIDO,
    })
    expect(response.statusCode).toBe(201)
  })
})

/**
 * MOD-PORTAL — a superfície do tutor.
 *
 * **A última suíte a perder o eco, e a que mais ganhou com isso.** Até a fatia 11 o Portal
 * era outro processo: estes testes conferiam o contexto assinado que saía daqui, o que
 * mostrava o que o gateway resolveu mas não que alguém o obedecesse. Agora o módulo
 * responde no mesmo processo, e o que se prova é o efeito — a sessão resolvida pelo host
 * alcança a ficha certa, e o mesmo login no Admin não alcança nada.
 */
describe('MOD-PORTAL — a superfície do tutor', () => {
  const SLUG_HEADER = 'x-petshop-tenant-slug'

  /**
   * O Portal lê `tenant_settings` para montar a identidade visual, e o `seedTenant` do
   * núcleo não a cria — os módulos do Admin não precisam dela. Todo tenant real sai do
   * onboarding com a linha; aqui ela é acrescentada onde o cenário exige.
   */
  async function comIdentidadeVisual(tenantId: string) {
    await ownerPrisma.tenantSettings.create({
      data: { tenantId, branding: { primaryColor: '#2E7D32' }, businessHours: {} },
    })
  }

  it('resolve a sessão pelo host e chega à ficha vinculada', async () => {
    const tenant = await seedTenant('petshop-portal', 'ACTIVE', 'PRO')
    await comIdentidadeVisual(tenant.tenantId)
    const { userId, clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const { tutorId } = await seedPortalTutor(tenant.tenantId, userId)

    // O token **não** tem Organization: o tutor não é membro de nada. Quem diz de que
    // petshop se fala é o host, e é o que este header carrega.
    const response = await call({
      url: '/portal/v1/me',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: tenant.slug },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().tutor?.id).toBe(tutorId)
  })

  /**
   * AC-04 de MOD-PORTAL-11 — a fronteira que o prefixo desenha.
   *
   * O mesmo login que é tutor aqui é **recepcionista** no Admin, e a sessão do Portal não
   * empresta nada de um lado para o outro: as permissões `_own` não abrem `/v1`, e o papel
   * de equipe não aparece no Portal. Enquanto os dois eram processos diferentes, isso era
   * uma consequência de estarem separados; agora é uma decisão que este teste guarda.
   */
  it('a sessão do Portal não alcança o Admin, e o crachá não alcança o Portal', async () => {
    const tenant = await seedTenant('petshop-banhista', 'ACTIVE', 'PRO')
    const { userId, clerkUserId } = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    await seedPortalTutor(tenant.tenantId, userId)

    // Sem Organization no token e com o header do host: é tutor, e o Admin recusa.
    const comoTutor = givenToken({ clerkUserId })
    const admin = await call({ url: '/v1/tutors', token: comoTutor })
    expect(admin.statusCode).toBe(403)

    // Com Organization e sem o header: é equipe, e o Portal recusa antes de tudo.
    const comoEquipe = givenToken({ clerkUserId, clerkOrgId: tenant.clerkOrgId })
    const portal = await call({ url: '/portal/v1/me', token: comoEquipe })
    expect(portal.statusCode).toBe(404)
    expect(portal.json().code).toBe('ERR_PORTAL_001')
  })

  it('a sessão sem ficha vinculada não alcança as rotas do tutor', async () => {
    const tenant = await seedTenant('petshop-sem-ficha', 'ACTIVE', 'PRO')
    const { clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')

    /**
     * `/portal/v1/me`, e não uma rota sob escopo `_own`: aquelas declaram a permissão no
     * `preHandler` e respondem **403** antes de chegar ao `requireTutorContext`. O 401 do
     * AC-05 de MOD-PORTAL-02 é o desta, que descreve a sessão em si.
     */
    const response = await call({
      url: '/portal/v1/me',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: tenant.slug },
    })

    expect(response.statusCode).toBe(401)
  })

  it('sem o header de host não há de que petshop falar', async () => {
    const tenant = await seedTenant('petshop-sem-host', 'ACTIVE', 'PRO')
    const { clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')

    const response = await call({ url: '/portal/v1/me', token: givenToken({ clerkUserId }) })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_PORTAL_001')
  })

  it('subdomínio de tenant suspenso responde como inexistente', async () => {
    const tenant = await seedTenant('petshop-suspenso', 'SUSPENDED', 'PRO')
    const { userId, clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    await seedPortalTutor(tenant.tenantId, userId)

    const response = await call({
      url: '/portal/v1/me',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: tenant.slug },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * O slug forjado não empresta ficha nenhuma.
   *
   * O vínculo é **por tenant**: a pessoa tem ficha no petshop dela e nenhuma no alheio. A
   * sessão resolve para aquele tenant sem `tutorId`, e quem recusa é `requireTutorContext`
   * — 401, e não 403, porque não é falta de permissão: é uma sessão que não representa
   * cliente algum daquele estabelecimento.
   */
  it('o slug forjado de outro petshop não empresta ficha nenhuma', async () => {
    const meu = await seedTenant('petshop-meu', 'ACTIVE', 'PRO')
    const alheio = await seedTenant('petshop-alheio', 'ACTIVE', 'PRO')
    const { userId, clerkUserId } = await seedMember(meu.tenantId, 'RECEPTIONIST')
    await seedPortalTutor(meu.tenantId, userId)

    const response = await call({
      url: '/portal/v1/me',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: alheio.slug },
    })

    expect(response.statusCode).toBe(401)
  })

  /**
   * A tela de login, antes de haver login.
   *
   * É a única rota do Portal fora do hook de sessão, e o `app.ts` a libera pelo caminho
   * exato — não pelo prefixo. Uma rota nova sob `/portal/v1/` nasce exigindo sessão, que é
   * o oposto do que acontece sob `/public/`.
   */
  it('a identidade visual do petshop responde sem token', async () => {
    const tenant = await seedTenant('petshop-vitrine', 'ACTIVE', 'PRO')
    await comIdentidadeVisual(tenant.tenantId)
    const app = await getApp()

    const response = await app.inject({
      method: 'GET',
      url: '/portal/v1/tenant',
      headers: { [SLUG_HEADER]: tenant.slug },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().slug).toBe(tenant.slug)
  })
})
