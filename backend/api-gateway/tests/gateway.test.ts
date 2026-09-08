import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SERVICE_HEADERS, verifyServiceHeaders } from '@petshop/service-auth'
import {
  closeHarness,
  echoed,
  getApp,
  getGateway,
  givenToken,
  lastEchoed,
  ownerPrisma,
  resetDatabase,
  seedMember,
  seedPortalTutor,
  seedTenant,
} from './harness.js'

/** O backend — autenticação, resolução de tenant e propagação de contexto. */

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET!

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

  it('a busca de tutores é atendida aqui; o pacote dele, ainda encaminhado', async () => {
    const tenant = await seedTenant('rotatutor')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    /**
     * O MOD-TUTOR virou módulo na fatia 6, então `/v1/tutors` não sai mais do
     * processo. O que continua saindo é `/v1/tutors/:id/packages`, que é do financeiro
     * — e é essa distinção que o teste guarda: as duas rotas partilham prefixo e vão
     * para lugares diferentes.
     */
    const antes = echoed.length
    await call({ url: '/v1/tutors?q=maria', token })
    expect(echoed.length).toBe(antes)

    await call({ url: '/v1/tutors/11111111-1111-4111-8111-111111111111/packages', token })
    const forwarded = lastEchoed()
    expect(forwarded.url).toContain('/packages')
    const verified = verifyServiceHeaders(forwarded.headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.context.tenantId).toBe(tenant.tenantId)
  })

  it('/v1/pets e o catálogo de domínio são atendidos aqui, não encaminhados', async () => {
    const tenant = await seedTenant('rotapet')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    /**
     * Eram quatro rotas encaminhadas ao pet-service até a fatia 5 da consolidação.
     * Hoje o módulo responde por elas no próprio processo, e o que este teste guarda
     * é justamente isso: **nada** sai daqui. Se um dia uma delas voltar a aparecer no
     * eco, é porque alguém a devolveu ao `resolveTarget` sem querer.
     */
    for (const url of ['/v1/pets?q=thor', '/v1/species', '/v1/sizes', '/v1/coats']) {
      const antes = echoed.length
      const response = await call({ url, token })
      expect(response.statusCode).not.toBe(404)
      expect(echoed.length).toBe(antes)
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

    const antes = echoed.length
    const response = await call({
      method: 'POST',
      url: `/v1/pets/${'11111111-1111-4111-8111-111111111111'}/photos`,
      token,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })

    /**
     * O upload virou rota do módulo na fatia 5, com o `@fastify/multipart` do escopo
     * dele. O que se prova aqui é que o corpo binário **chega**: um 404 de pet
     * inexistente ou um 422 de imagem inválida significam que o parser leu o arquivo;
     * um 400 de multipart quebrado significaria que o parser errado o pegou.
     *
     * O repasse byte a byte do escopo do proxy continua registrado, mas hoje não tem
     * consumidor: nenhum serviço ainda por migrar recebe multipart. Ele sai junto com
     * o `proxy.ts`, na última fatia.
     */
    expect([404, 422]).toContain(response.statusCode)
    expect(echoed.length).toBe(antes)
  })

  it('roteia o prontuário para o medical-record-service, não para o pet-service', async () => {
    const tenant = await seedTenant('rotapront')
    const member = await seedMember(tenant.tenantId, 'VET')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })
    const petId = '11111111-1111-4111-8111-111111111111'

    // As rotas do prontuário moram debaixo de `/v1/pets/:petId/…`, então o
    // roteamento é por sufixo e precisa ganhar do prefixo de pets.
    for (const suffix of ['/allergies', '/temperament', '/medical-alerts', '/safety-record', '/alerts']) {
      const response = await call({ url: `/v1/pets/${petId}${suffix}`, token })
      expect(response.statusCode).toBe(200)

      const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
      expect(verified.ok).toBe(true)
      if (!verified.ok) return
      expect(verified.context.permissions).toContain('record:read_alerts')
    }

    // O pet em si é atendido aqui desde a fatia 5, e por isso **não** aparece no eco.
    const antes = echoed.length
    await call({ url: `/v1/pets/${petId}`, token })
    expect(echoed.length).toBe(antes)
  })

  it('roteia o catálogo da agenda para o scheduling-service', async () => {
    const tenant = await seedTenant('rotaagenda')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    for (const path of ['/v1/services', '/v1/professionals', '/v1/calendar-blocks']) {
      const response = await call({ url: path, token })
      expect(response.statusCode).toBe(200)
      expect(lastEchoed().url).toBe(path)

      const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
      expect(verified.ok).toBe(true)
      if (!verified.ok) return
      expect(verified.context.permissions).toContain('schedule:manage_catalog')
    }

    /**
     * `/v1/sizes` é catálogo de pet, e desde a fatia 5 é atendido neste processo. O que
     * o teste guarda continua sendo a mesma distinção de antes: `matches` compara
     * segmento inteiro, então `/v1/services` **não** captura `/v1/sizes` por prefixo
     * textual — se capturasse, o porte do pet iria parar na agenda.
     */
    const antes = echoed.length
    await call({ url: '/v1/sizes', token })
    expect(echoed.length).toBe(antes)
  })

  it('devolve 404 para rota sem serviço de destino', async () => {
    const token = givenToken({ clerkUserId: 'user_semrota' })
    const response = await call({ url: '/v1/inexistente', token })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_IDENT_001')
  })
})

describe('propagação do contexto ao serviço', () => {
  it('assina os headers com o contexto resolvido', async () => {
    const tenant = await seedTenant('propaga')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({
      clerkUserId: member.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
      permVersion: 1,
    })

    const response = await call({ url: '/v1/memberships', token })
    expect(response.statusCode).toBe(200)

    const forwarded = lastEchoed()
    const verified = verifyServiceHeaders(forwarded.headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return

    expect(verified.context.clerkUserId).toBe(member.clerkUserId)
    expect(verified.context.userId).toBe(member.userId)
    expect(verified.context.tenantId).toBe(tenant.tenantId)
    expect(verified.context.role).toBe('RECEPTIONIST')
    expect(verified.context.permissions).toContain('tutor:read')
    expect(verified.context.permissions).not.toContain('tutor:delete')
  })

  it('não repassa o Authorization do cliente adiante', async () => {
    const tenant = await seedTenant('semauth')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await call({ url: '/v1/roles', token })

    // O serviço de destino nunca vê o token do usuário.
    expect(lastEchoed().headers.authorization).toBeUndefined()
  })

  it('descarta headers internos forjados pelo cliente', async () => {
    const tenant = await seedTenant('forjado')
    const outro = await seedTenant('vitima')
    const member = await seedMember(tenant.tenantId, 'BATHER')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    // O cliente tenta se declarar admin de outro tenant.
    await call({
      url: '/v1/roles',
      token,
      headers: {
        [SERVICE_HEADERS.tenantId]: outro.tenantId,
        [SERVICE_HEADERS.role]: 'TENANT_ADMIN',
        [SERVICE_HEADERS.permissions]: 'tutor:delete,finance:refund',
      },
    })

    const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return

    // Prevalece o que o gateway resolveu, não o que o cliente afirmou.
    expect(verified.context.tenantId).toBe(tenant.tenantId)
    expect(verified.context.role).toBe('BATHER')
    expect(verified.context.permissions).not.toContain('tutor:delete')
  })

  it('encaminha sem tenant quando o usuário ainda não tem Organization', async () => {
    const token = givenToken({ clerkUserId: 'user_novo', clerkOrgId: null })

    const response = await call({
      method: 'POST',
      url: '/v1/tenants',
      token,
      payload: { name: 'Petshop Novo', slug: 'petshopnovo' },
    })
    expect(response.statusCode).toBe(200)

    const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.context.tenantId).toBeUndefined()
    expect(verified.context.clerkUserId).toBe('user_novo')
  })

  it('repassa o corpo e o request id', async () => {
    const tenant = await seedTenant('corpo')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await call({
      method: 'PATCH',
      url: '/v1/tenants/me',
      token,
      payload: { name: 'Novo Nome' },
    })

    const forwarded = lastEchoed()
    expect(forwarded.body).toEqual({ name: 'Novo Nome' })
    expect(forwarded.headers['x-request-id']).toBeTruthy()
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

    const before = await call({ url: '/v1/roles', token })
    expect(before.statusCode).toBe(200)
    const permissionsBefore = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(permissionsBefore.ok && permissionsBefore.context.permissions).toContain('tutor:delete')

    // O admin rebaixa o usuário; permVersion vai para 2.
    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { roleKey: 'RECEPTIONIST', permVersion: 2 },
    })

    // Mesmo token de antes: o gateway detecta e aplica o papel novo.
    const after = await call({ url: '/v1/roles', token })
    expect(after.statusCode).toBe(200)
    const permissionsAfter = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(permissionsAfter.ok).toBe(true)
    if (!permissionsAfter.ok) return
    expect(permissionsAfter.context.role).toBe('RECEPTIONIST')
    expect(permissionsAfter.context.permissions).not.toContain('tutor:delete')
    expect(permissionsAfter.context.permVersion).toBe(2)
  })

  it('não envia permissão nenhuma quando o membership foi removido', async () => {
    const tenant = await seedTenant('removido')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { status: 'REMOVED' },
    })

    await call({ url: '/v1/roles', token })
    const verified = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.context.permissions).toEqual([])
    expect(verified.context.role).toBeUndefined()
  })
})

describe('RN-04 — tenant suspenso', () => {
  it('bloqueia escrita com 423 ERR_IDENT_008', async () => {
    const tenant = await seedTenant('suspenso', 'SUSPENDED')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'PATCH',
      url: '/v1/tenants/me',
      token,
      payload: { name: 'Tentativa' },
    })

    expect(response.statusCode).toBe(423)
    expect(response.json().code).toBe('ERR_IDENT_008')
    expect(response.json().detail).toContain('Regularize a assinatura')
  })

  it('mantém a leitura liberada, para consulta e exportação LGPD', async () => {
    const tenant = await seedTenant('suspensoleitura', 'SUSPENDED')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({ url: '/v1/tenants/me', token })
    expect(response.statusCode).toBe(200)
  })

  it('não bloqueia tenant ativo', async () => {
    const tenant = await seedTenant('ativo', 'ACTIVE')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const response = await call({
      method: 'PATCH',
      url: '/v1/tenants/me',
      token,
      payload: { name: 'Permitido' },
    })
    expect(response.statusCode).toBe(200)
  })
})

/**
 * Roteamento por prefixo.
 *
 * `resolveTarget` é função pura, e testá-la direto vale mais que subir o proxy: o que
 * pode dar errado aqui é **ordem**, não transporte. Um prefixo colocado depois de
 * outro que o engloba manda a rota para o serviço errado sem erro nenhum — o pedido
 * chega, alguém responde 404, e ninguém desconfia do gateway.
 */
describe('resolveTarget — a que serviço cada rota pertence', () => {
  it('manda o financeiro para o billing-ledger-service', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    const { loadEnv } = await import('../src/config/env.js')
    const ledger = loadEnv().BILLING_LEDGER_SERVICE_URL

    for (const path of [
      '/v1/ledger/accounts/abc',
      '/v1/ledger/accounts/abc/statement',
      '/v1/ledger/entries',
      '/v1/payments',
      '/v1/packages',
      '/v1/packages/abc/purchases',
      '/v1/billing-settings',
    ]) {
      expect(resolveTarget(path)).toBe(ledger)
    }
  })

  it('os pacotes do tutor vencem o prefixo de tutores', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    const { loadEnv } = await import('../src/config/env.js')
    const env = loadEnv()

    /**
     * A exceção do financeiro sobreviveu à fatia 6: `/v1/tutors/:id/packages` continua
     * saindo daqui, porque **nenhuma rota do módulo do tutor casa com ela**. O resto
     * do tutor é atendido no processo e `resolveTarget` devolve `null`.
     *
     * No dia em que alguém registrar `/v1/tutors/:id/packages` no módulo do tutor, o
     * roteador do Fastify passa a preferi-la e o pacote some sem erro nenhum — este
     * teste é o que avisa.
     */
    expect(resolveTarget('/v1/tutors/abc/packages')).toBe(env.BILLING_LEDGER_SERVICE_URL)
    expect(resolveTarget('/v1/tutors/abc')).toBeNull()
    expect(resolveTarget('/v1/tutors/abc/overview')).toBeNull()
  })

  it('`/v1/services` continua sendo da agenda, não do catálogo de pacotes', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    const { loadEnv } = await import('../src/config/env.js')

    expect(resolveTarget('/v1/services')).toBe(loadEnv().SCHEDULING_SERVICE_URL)
  })

  it('o prontuário vence o prefixo de pets, inclusive na linha do tempo e no resumo', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    const { loadEnv } = await import('../src/config/env.js')
    const env = loadEnv()

    for (const suffix of [
      'timeline',
      'summary',
      'allergies',
      'alerts',
      'safety-record',
      // MOD-DOC-04: o receituário do pet é do prontuário, não do cadastro.
      'prescriptions',
    ]) {
      expect(resolveTarget(`/v1/pets/abc/${suffix}`)).toBe(env.MEDICAL_RECORD_SERVICE_URL)
    }
    /**
     * E o cadastro do pet **não é encaminhado a lugar nenhum**: virou módulo deste
     * processo na fatia 5 da consolidação, e `resolveTarget` devolve `null`.
     *
     * A exceção do prontuário sobreviveu à mudança, e é isso que este teste passou a
     * provar: `/v1/pets/:id/timeline` continua saindo daqui porque **nenhuma rota do
     * módulo do pet casa com ela**, e o curinga a leva ao prontuário. No dia em que
     * alguém registrar `/v1/pets/:id/timeline` no módulo do pet, o roteador do Fastify
     * passa a preferi-la e a linha do tempo some sem erro nenhum — este teste é o que
     * avisa.
     */
    expect(resolveTarget('/v1/pets/abc')).toBeNull()
    expect(resolveTarget('/v1/pets/abc/photos')).toBeNull()
  })

  it('a linha do tempo do pet sai do processo; o cadastro dele, não', async () => {
    const app = await getApp()
    const tenant = await seedTenant('rota-pet')
    const membro = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({
      clerkUserId: membro.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
    })

    await app.inject({
      method: 'GET',
      url: '/v1/pets/00000000-0000-0000-0000-000000000001/timeline',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(lastEchoed().url).toContain('/timeline')

    const antes = echoed.length
    await app.inject({
      method: 'GET',
      url: '/v1/pets/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${token}` },
    })
    // Nada chegou ao serviço de destino: quem respondeu foi o módulo, aqui dentro.
    expect(echoed.length).toBe(antes)
  })

  it('o atendimento é do prontuário; o agendamento, da agenda', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    const { loadEnv } = await import('../src/config/env.js')
    const env = loadEnv()

    expect(resolveTarget('/v1/attendances')).toBe(env.MEDICAL_RECORD_SERVICE_URL)
    expect(resolveTarget('/v1/attendances/abc/addendum')).toBe(env.MEDICAL_RECORD_SERVICE_URL)
    // MOD-DOC-04: o receituário é documento, mas quem sabe o que é uma prescrição é o
    // prontuário — o `document-service:3012` do SPEC não nasce.
    expect(resolveTarget('/v1/attendances/abc/prescriptions')).toBe(
      env.MEDICAL_RECORD_SERVICE_URL,
    )
    expect(resolveTarget('/v1/prescriptions/abc')).toBe(env.MEDICAL_RECORD_SERVICE_URL)
    expect(resolveTarget('/v1/prescriptions/abc/void')).toBe(env.MEDICAL_RECORD_SERVICE_URL)
    // O encaixe cria agendamento: é da agenda, apesar de o registro clínico não ser.
    expect(resolveTarget('/v1/appointments/walk-in')).toBe(env.SCHEDULING_SERVICE_URL)
    expect(resolveTarget('/v1/appointments/abc/checkout')).toBe(env.SCHEDULING_SERVICE_URL)
  })

  it('rota desconhecida não é roteada para lugar nenhum', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    expect(resolveTarget('/v1/inexistente')).toBeNull()
  })
})

describe('MOD-PORTAL — a superfície do tutor', () => {
  const SLUG_HEADER = 'x-petshop-tenant-slug'

  it('resolve a sessão pelo host e assina o contexto com tutorId e as permissões `_own`', async () => {
    const tenant = await seedTenant('petshop-portal')
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
    const forwarded = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(forwarded.ok).toBe(true)
    if (!forwarded.ok) return
    expect(forwarded.context.tutorId).toBe(tutorId)
    expect(forwarded.context.role).toBe('TUTOR')
    expect(forwarded.context.tenantId).toBe(tenant.tenantId)
    expect(forwarded.context.permissions).toContain('pet:read_own')
    // O que o papel de equipe daria fica de fora: o mesmo login, no Portal, é tutor.
    expect(forwarded.context.permissions).not.toContain('tutor:read')
  })

  it('AC-04 de MOD-PORTAL-02: quem é funcionário e cliente entra no Portal como tutor', async () => {
    const tenant = await seedTenant('petshop-banhista')
    const { userId, clerkUserId } = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    await seedPortalTutor(tenant.tenantId, userId)

    // O mesmo token que no Admin daria acesso total.
    const token = givenToken({ clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const portal = await call({
      url: '/portal/v1/me',
      token,
      headers: { [SLUG_HEADER]: tenant.slug },
    })
    expect(portal.statusCode).toBe(200)

    const context = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.context.role).toBe('TUTOR')
    expect(context.context.permissions).not.toContain('tenant:configure')
  })

  it('a sessão sem ficha vinculada segue sem tutorId e sem permissão nenhuma', async () => {
    const tenant = await seedTenant('petshop-sem-ficha')
    const { clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')

    const response = await call({
      url: '/portal/v1/access/challenge',
      method: 'POST',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: tenant.slug },
      payload: { identifier: 'maria@exemplo.com' },
    })

    expect(response.statusCode).toBe(200)
    const forwarded = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(forwarded.ok).toBe(true)
    if (!forwarded.ok) return
    expect(forwarded.context.tutorId).toBeUndefined()
    expect(forwarded.context.permissions).toEqual([])
  })

  it('sem o header de host não há de que petshop falar', async () => {
    const tenant = await seedTenant('petshop-sem-host')
    const { clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')

    const response = await call({ url: '/portal/v1/me', token: givenToken({ clerkUserId }) })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('ERR_PORTAL_001')
  })

  it('subdomínio de tenant suspenso responde como inexistente', async () => {
    const tenant = await seedTenant('petshop-suspenso', 'SUSPENDED')
    const { userId, clerkUserId } = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    await seedPortalTutor(tenant.tenantId, userId)

    const response = await call({
      url: '/portal/v1/me',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: tenant.slug },
    })

    expect(response.statusCode).toBe(404)
  })

  it('o slug forjado de outro petshop não empresta ficha nenhuma', async () => {
    const meu = await seedTenant('petshop-meu')
    const alheio = await seedTenant('petshop-alheio')
    const { userId, clerkUserId } = await seedMember(meu.tenantId, 'RECEPTIONIST')
    await seedPortalTutor(meu.tenantId, userId)

    const response = await call({
      url: '/portal/v1/me',
      token: givenToken({ clerkUserId }),
      headers: { [SLUG_HEADER]: alheio.slug },
    })

    // A requisição chega ao BFF, mas sem `tutorId`: o vínculo é por tenant, e neste
    // aqui a pessoa não tem ficha. Quem responde 401 é o `requireTutorContext`.
    expect(response.statusCode).toBe(200)
    const forwarded = verifyServiceHeaders(lastEchoed().headers, INTERNAL_SECRET)
    expect(forwarded.ok).toBe(true)
    if (!forwarded.ok) return
    expect(forwarded.context.tenantId).toBe(alheio.tenantId)
    expect(forwarded.context.tutorId).toBeUndefined()
  })

  it('o prefixo do Portal vai para o portal-bff, e nada mais vai', async () => {
    const { resolveTarget } = await import('../src/proxy.js')
    const { loadEnv } = await import('../src/config/env.js')
    const env = loadEnv()

    expect(resolveTarget('/portal/v1/me')).toBe(env.PORTAL_BFF_URL)
    expect(resolveTarget('/portal/v1/access/challenge')).toBe(env.PORTAL_BFF_URL)
    // O prefixo administrativo continua separado: a distinção é o AC-04 de
    // MOD-PORTAL-11, e é ela que garante que nenhum tutor alcance `/v1`. Desde a
    // fatia 6 `/v1/tutors` é atendido aqui, então o que se prova é que ele **não** cai
    // no BFF do Portal.
    expect(resolveTarget('/v1/tutors')).toBeNull()
  })
})
