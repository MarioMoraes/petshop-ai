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

  /**
   * O que a fatia 7 mudou de lugar.
   *
   * As seis famílias de rota do MOD-IDENT saíam do processo até aqui. A asserção se
   * inverte a cada fatia — de "vai para o serviço X" para "não sai" — e é assim que
   * deve ser: é o único sinal de que o encaminhamento sumiu de fato, e não que a rota
   * sumiu junto.
   */
  it('as rotas de identidade não saem mais do processo', async () => {
    const tenant = await seedTenant('rotaident')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const antes = echoed.length
    for (const url of ['/v1/me', '/v1/roles', '/v1/memberships', '/v1/invitations']) {
      const response = await call({ url, token })
      expect(response.statusCode).toBe(200)
    }
    expect(echoed.length).toBe(antes)
  })

  it('nem a busca de tutores nem o pacote dele saem do processo', async () => {
    const tenant = await seedTenant('rotatutor')
    const member = await seedMember(tenant.tenantId, 'RECEPTIONIST')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    /**
     * O MOD-TUTOR virou módulo na fatia 6 e o MOD-LEDGER na 10. As duas rotas
     * partilhavam prefixo e iam para lugares diferentes — era a última exceção do
     * `proxy.ts`, e é por isso que este teste continua exercitando as duas juntas.
     */
    const antes = echoed.length
    await call({ url: '/v1/tutors?q=maria', token })
    await call({ url: '/v1/tutors/11111111-1111-4111-8111-111111111111/packages', token })
    expect(echoed.length).toBe(antes)
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

  /**
   * A asserção que a fatia 8 inverteu.
   *
   * Ela guardava a exceção por sufixo: as rotas do prontuário moram sob
   * `/v1/pets/:petId/…` e o `proxy.ts` precisava desempatá-las contra o prefixo do pet
   * **antes** de rotear. O desempate era uma lista escrita à mão, e funcionava por
   * coincidência. Com o MOD-PRONT dentro, quem desempata é o roteador, e o que resta a
   * provar é que nada sob `/v1/pets/` procura destino externo.
   */
  it('nem o pet nem o prontuário dele saem do processo', async () => {
    const tenant = await seedTenant('rotapront')
    const member = await seedMember(tenant.tenantId, 'VET')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })
    const petId = '11111111-1111-4111-8111-111111111111'

    const antes = echoed.length
    for (const suffix of ['/allergies', '/temperament', '/medical-alerts', '/safety-record', '/alerts', '']) {
      await call({ url: `/v1/pets/${petId}${suffix}`, token })
    }
    expect(echoed.length).toBe(antes)
  })

  /**
   * O que a fatia 9 inverteu.
   *
   * As sete famílias de rota do MOD-AGENDA saíam para o scheduling-service, e o teste
   * anterior conferia a assinatura do contexto no caminho. Agora elas são atendidas
   * aqui, e o que se guarda é isto: nada da agenda tem destino externo, e `/v1/services`
   * continua sem capturar `/v1/sizes`, que é catálogo de pet.
   */
  it('as rotas da agenda não saem mais do processo', async () => {
    const tenant = await seedTenant('rotaagenda')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })

    const antes = echoed.length
    for (const path of [
      '/v1/services',
      '/v1/professionals',
      // O bloqueio é consultado por período, e o módulo exige a janela — 422 sem ela.
      '/v1/calendar-blocks?from=2030-01-01T00:00:00.000Z&to=2030-01-02T00:00:00.000Z',
      '/v1/sizes',
    ]) {
      const response = await call({ url: path, token })
      expect(response.statusCode).toBe(200)
    }
    expect(echoed.length).toBe(antes)
  })

  it('devolve 404 para rota sem serviço de destino', async () => {
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
 * Roteamento por prefixo.
 *
 * `resolveTarget` é função pura, e testá-la direto vale mais que subir o proxy: o que
 * pode dar errado aqui é **ordem**, não transporte. Um prefixo colocado depois de
 * outro que o engloba manda a rota para o serviço errado sem erro nenhum — o pedido
 * chega, alguém responde 404, e ninguém desconfia do gateway.
 */
describe('resolveTarget — a que serviço cada rota pertence', () => {
  it('nada do financeiro tem destino externo desde a fatia 10', async () => {
    const { resolveTarget } = await import('../src/proxy.js')

    for (const path of [
      '/v1/ledger/accounts/abc',
      '/v1/ledger/accounts/abc/statement',
      '/v1/ledger/entries',
      '/v1/payments',
      '/v1/packages',
      '/v1/packages/abc/purchases',
      '/v1/billing-settings',
    ]) {
      expect(resolveTarget(path)).toBeNull()
    }
  })

  /**
   * **A última exceção de prefixo, e a asserção que ela deixou.**
   *
   * `/v1/tutors/:tutorId/packages` saía daqui até a fatia 10, desempatada por uma
   * checagem de sufixo conferida antes do prefixo dos tutores. Ela funcionava porque
   * nenhuma rota do MOD-TUTOR casava com ela — e o dia em que alguém registrasse uma que
   * casasse, o pacote sumiria sem erro nenhum, em produção.
   *
   * Agora quem desempata é o roteador. O que este teste guarda é que a rota continua
   * existindo e sendo atendida aqui: `:tutorId` do financeiro convivendo com `:id` do
   * tutor na mesma posição é a coisa que alguém "arruma" um dia sem saber que pode.
   */
  it('os pacotes do tutor são atendidos aqui, ao lado das rotas do tutor', async () => {
    const { resolveTarget } = await import('../src/proxy.js')

    expect(resolveTarget('/v1/tutors/abc/packages')).toBeNull()
    expect(resolveTarget('/v1/tutors/abc')).toBeNull()
    expect(resolveTarget('/v1/tutors/abc/overview')).toBeNull()

    const tenant = await seedTenant('rotapacote')
    const member = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({ clerkUserId: member.clerkUserId, clerkOrgId: tenant.clerkOrgId })
    const tutorId = '11111111-1111-4111-8111-111111111111'

    const antes = echoed.length
    for (const url of [`/v1/tutors/${tutorId}/packages`, `/v1/tutors/${tutorId}/overview`]) {
      const response = await call({ url, token })
      // 404 do RLS (o tutor não existe), e não 404 de rota inexistente: as duas foram
      // encontradas pelo roteador.
      expect(response.json().code).not.toBe('ERR_IDENT_001')
    }
    expect(echoed.length).toBe(antes)
  })

  it('nada da agenda tem destino externo desde a fatia 9', async () => {
    const { resolveTarget } = await import('../src/proxy.js')

    for (const path of [
      '/v1/services',
      '/v1/services/abc/pricing',
      '/v1/professionals',
      '/v1/calendar-blocks',
      '/v1/availability',
      '/v1/agenda/day',
      '/v1/appointments',
      '/v1/recurrences',
    ]) {
      expect(resolveTarget(path)).toBeNull()
    }
  })

  /**
   * A asserção que se inverteu na fatia 8, e a mais importante desta suíte.
   *
   * Até aqui, `/v1/pets/:id/timeline` **saía** do processo: o `proxy.ts` tinha uma lista
   * de sufixos conferida antes do prefixo do pet, e o teste anterior guardava a exceção.
   * Ela funcionava por coincidência — nenhuma rota do módulo do pet casava com aqueles
   * sufixos — e o dia em que alguém registrasse uma que casasse, o Fastify preferiria a
   * do módulo e a rota do prontuário sumiria sem erro nenhum, em produção.
   *
   * Com o MOD-PRONT dentro, a lista sumiu e o desempate passou a ser o roteador. O que
   * este teste guarda agora é que **nada** sob `/v1/pets/` tem destino externo.
   */
  it('nem o cadastro do pet nem o prontuário dele saem do processo', async () => {
    const { resolveTarget } = await import('../src/proxy.js')

    for (const suffix of [
      'timeline',
      'summary',
      'allergies',
      'alerts',
      'safety-record',
      'prescriptions',
    ]) {
      expect(resolveTarget(`/v1/pets/abc/${suffix}`)).toBeNull()
    }
    expect(resolveTarget('/v1/pets/abc')).toBeNull()
    expect(resolveTarget('/v1/pets/abc/photos')).toBeNull()
  })

  it('a linha do tempo e o cadastro do pet são atendidos aqui, sem sair', async () => {
    const app = await getApp()
    const tenant = await seedTenant('rota-pet')
    const membro = await seedMember(tenant.tenantId, 'TENANT_ADMIN')
    const token = givenToken({
      clerkUserId: membro.clerkUserId,
      clerkOrgId: tenant.clerkOrgId,
    })

    const antes = echoed.length
    for (const url of [
      '/v1/pets/00000000-0000-0000-0000-000000000001/timeline',
      '/v1/pets/00000000-0000-0000-0000-000000000001',
    ]) {
      await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    }
    // Nada chegou ao serviço de destino: quem respondeu foi o módulo, aqui dentro.
    expect(echoed.length).toBe(antes)
  })

  it('nem o atendimento nem o agendamento saem do processo', async () => {
    const { resolveTarget } = await import('../src/proxy.js')

    // O prontuário virou módulo na fatia 8: nada dele sai mais.
    for (const path of [
      '/v1/attendances',
      '/v1/attendances/abc/addendum',
      '/v1/attendances/abc/prescriptions',
      '/v1/prescriptions/abc',
      '/v1/prescriptions/abc/void',
    ]) {
      expect(resolveTarget(path)).toBeNull()
    }

    /**
     * **A distinção que este teste guardava agora vive na árvore de rotas.**
     * `/v1/attendances` e `/v1/appointments` não colidem, mas a proximidade dos dois é o
     * tipo de coisa que alguém "consolida" um dia: o registro clínico é do prontuário, o
     * horário é da agenda, e o encaixe cria agendamento — apesar de o registro que ele
     * gera não ser. Com os dois módulos no mesmo processo desde a fatia 9, um conflito
     * apareceria no boot; o que sobra aqui é provar que nenhum dos dois sai.
     */
    expect(resolveTarget('/v1/appointments/walk-in')).toBeNull()
    expect(resolveTarget('/v1/appointments/abc/checkout')).toBeNull()
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
    // E, desde a fatia 7, nenhuma rota de identidade tem destino.
    for (const path of ['/v1/me', '/v1/roles', '/v1/memberships', '/v1/invitations', '/v1/tenants']) {
      expect(resolveTarget(path)).toBeNull()
    }
  })
})
