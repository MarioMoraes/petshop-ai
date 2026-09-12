import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setSchedulingPort } from '../../src/modules/identity/scheduling-port.js'
import {
  asAdmin,
  asRole,
  asStranger,
  callApi,
  closeHarness,
  fakeClerk,
  givenTeamMember,
  givenTenant,
  grantPermission,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
} from './fixtures.js'

/**
 * MOD-IDENT-05 — suspender, remover e trocar de estabelecimento.
 *
 * A troca já funcionava no navegador antes desta fatia, pelo `setActive` do Clerk; o que
 * não existia era **conferir o vínculo e deixar prova da troca**. E tirar alguém da
 * equipe não existia de forma nenhuma: a única coisa que a tela fazia era trocar o
 * papel.
 */

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
})

afterEach(() => {
  setSchedulingPort(null)
})

afterAll(closeHarness)

describe('suspender e reativar', () => {
  it('suspende o acesso e a sessão seguinte deixa de resolver permissão', async () => {
    const session = await givenTenant('suspende')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'recepcaosusp')

    // Antes: a recepção lista a equipe, porque `team:read` está na matriz do papel.
    const antes = await callApi({
      clerkUserId: member.clerkUserId,
      clerkOrgId: session.clerkOrgId,
      method: 'GET',
      url: '/v1/memberships',
    })
    expect(antes.statusCode).toBe(200)

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}/status`,
      payload: { status: 'SUSPENDED' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'SUSPENDED' })

    /**
     * O que de fato fecha a porta é `resolveEffectivePermissions`, que só enxerga
     * vínculo `ACTIVE` — e é por isso que a asserção é sobre a **requisição seguinte**,
     * e não sobre a coluna.
     */
    const depois = await callApi({
      clerkUserId: member.clerkUserId,
      clerkOrgId: session.clerkOrgId,
      method: 'GET',
      url: '/v1/memberships',
    })
    expect(depois.statusCode).toBe(403)

    const trilha = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'membership.suspended' },
    })
    expect(trilha.actorUserId).toBe(session.userId)
  })

  it('reativa e a permissão volta', async () => {
    const session = await givenTenant('reativa')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'recepcaoreativa')
    await ownerPrisma.membership.update({
      where: { id: member.membershipId },
      data: { status: 'SUSPENDED' },
    })

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}/status`,
      payload: { status: 'ACTIVE' },
    })
    expect(response.statusCode).toBe(200)

    const volta = await callApi({
      clerkUserId: member.clerkUserId,
      clerkOrgId: session.clerkOrgId,
      method: 'GET',
      url: '/v1/memberships',
    })
    expect(volta.statusCode).toBe(200)
  })

  it('recusa suspender o último administrador com 409', async () => {
    const session = await givenTenant('suspendeultimo')

    /**
     * O cenário só existe com a matriz ajustada, e isso é informação sobre o sistema.
     *
     * `team:remove` mora só em `TENANT_ADMIN`: quem pode fechar a porta de alguém **é**
     * um administrador ativo e portanto nunca é o último. A guarda da RN-02 fica
     * alcançável quando o estabelecimento concede a permissão a outro papel, que é o
     * que `tenant_role_overrides` existe para permitir (MOD-IDENT-04).
     */
    await grantPermission(session, 'RECEPTIONIST', 'team:remove')

    const response = await callApi({
      ...(await asRole(session, 'RECEPTIONIST')),
      method: 'PATCH',
      url: `/v1/memberships/${session.membershipId}/status`,
      payload: { status: 'SUSPENDED' },
    })

    // Fechar a porta do único administrador trancaria o estabelecimento inteiro, sem
    // ninguém de dentro para destrancar.
    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toBe('O estabelecimento precisa de ao menos um administrador')
  })

  it('permite suspender um administrador quando há outro', async () => {
    const session = await givenTenant('suspendeoutroadmin')
    const outro = await givenTeamMember(session, 'TENANT_ADMIN', 'segundoadmin')

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${outro.membershipId}/status`,
      payload: { status: 'SUSPENDED' },
    })
    expect(response.statusCode).toBe(200)
  })

  it('recusa alterar o próprio acesso com 403', async () => {
    const session = await givenTenant('proprioacesso')

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${session.membershipId}/status`,
      payload: { status: 'SUSPENDED' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().detail).toBe('Você não pode alterar o seu próprio acesso')
  })

  it('não aceita REMOVED pelo corpo — remover é DELETE', async () => {
    const session = await givenTenant('statusremoved')
    const member = await givenTeamMember(session, 'BATHER', 'banhistaremoved')

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}/status`,
      payload: { status: 'REMOVED' },
    })

    // Dois caminhos para o mesmo efeito dariam um deles sem a guarda da agenda futura.
    expect(response.statusCode).toBe(422)
  })
})

describe('remover da equipe', () => {
  it('marca REMOVED, tira da Organization do Clerk e some da listagem', async () => {
    const session = await givenTenant('remove')
    const member = await givenTeamMember(session, 'GROOMER', 'tosadorremove')

    const response = await callApi({
      ...asAdmin(session),
      method: 'DELETE',
      url: `/v1/memberships/${member.membershipId}`,
    })

    expect(response.statusCode).toBe(200)
    const membership = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId },
    })
    // `REMOVED` e não `DELETE`: o vínculo é o antecedente do que a pessoa fez aqui.
    expect(membership.status).toBe('REMOVED')
    expect(membership.mfaGraceUntil).toBeNull()

    expect(fakeClerk.organizationRemovals).toContain(
      `${session.clerkOrgId}:${member.clerkUserId}`,
    )

    const equipe = await callApi({ ...asAdmin(session), method: 'GET', url: '/v1/memberships' })
    expect(equipe.json().map((linha: { id: string }) => linha.id)).not.toContain(
      member.membershipId,
    )

    await ownerPrisma.auditLog.findFirstOrThrow({ where: { action: 'membership.removed' } })
  })

  it('RN-07: agenda futura bloqueia com 409 e a resposta diz quais são', async () => {
    const session = await givenTenant('agendafutura')
    const member = await givenTeamMember(session, 'BATHER', 'banhistaagenda')

    setSchedulingPort({
      async listFutureProfessionalAppointments() {
        return [
          {
            id: '2f1f4d3c-0000-4000-8000-000000000001',
            startsAt: '2026-10-01T13:00:00.000Z',
            petName: 'Rex',
            serviceLabel: 'Banho e tosa',
          },
        ]
      },
    })

    const response = await callApi({
      ...asAdmin(session),
      method: 'DELETE',
      url: `/v1/memberships/${member.membershipId}`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_IDENT_004')
    // A decisão — reatribuir ou cancelar — é de quem está na tela, e por isso a lista
    // desce no corpo.
    expect(response.json().appointments).toHaveLength(1)
    expect(response.json().appointments[0]).toMatchObject({ petName: 'Rex' })

    const intacto = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId },
    })
    expect(intacto.status).toBe('ACTIVE')
  })

  it('recusa o último administrador antes de olhar a agenda', async () => {
    const session = await givenTenant('removeultimo')
    let consultouAgenda = false
    setSchedulingPort({
      async listFutureProfessionalAppointments() {
        consultouAgenda = true
        return []
      },
    })

    // Mesma razão do cenário de suspensão: a matriz precisa ser ajustada para que exista
    // alguém que possa remover sem ser administrador.
    await grantPermission(session, 'RECEPTIONIST', 'team:remove')

    const response = await callApi({
      ...(await asRole(session, 'RECEPTIONIST')),
      method: 'DELETE',
      url: `/v1/memberships/${session.membershipId}`,
    })

    expect(response.statusCode).toBe(409)
    /**
     * A ordem das guardas importa: as duas terminam em 409, e a do administrador é a
     * que a pessoa resolve sozinha promovendo alguém. Listar agendamentos para
     * reatribuir num caminho que ia ser recusado de qualquer jeito seria trabalho
     * pedido em vão.
     */
    expect(consultouAgenda).toBe(false)
  })

  it('nega à recepção, que não tem team:remove na matriz', async () => {
    const session = await givenTenant('recepcaoremove')
    const member = await givenTeamMember(session, 'GROOMER', 'tosadornega')

    const response = await callApi({
      ...(await asRole(session, 'RECEPTIONIST')),
      method: 'DELETE',
      url: `/v1/memberships/${member.membershipId}`,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().detail).toBe('Seu perfil não permite remover membros da equipe')
  })

  it('recusa reativar quem foi removido — a volta é por convite novo', async () => {
    const session = await givenTenant('readmite')
    const member = await givenTeamMember(session, 'GROOMER', 'tosadorreadmite')
    await callApi({
      ...asAdmin(session),
      method: 'DELETE',
      url: `/v1/memberships/${member.membershipId}`,
    })

    const response = await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}/status`,
      payload: { status: 'ACTIVE' },
    })

    // O assento do plano é conferido no convite (RN-11); reativar o pularia.
    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toContain('convite novo')
  })
})

describe('POST /v1/sessions/switch-tenant', () => {
  it('AC-01: confere o vínculo, audita no destino e devolve a Organization', async () => {
    const origem = await givenTenant('trocaorigem')
    const destino = await givenTenant('trocadestino')

    // A mesma pessoa nos dois estabelecimentos — o franqueado com duas unidades da
    // RN-01, e o único caso em que a troca existe.
    await ownerPrisma.membership.create({
      data: {
        tenantId: destino.tenantId,
        userId: origem.userId,
        roleKey: 'RECEPTIONIST',
        status: 'ACTIVE',
      },
    })

    const response = await callApi({
      ...asAdmin(origem),
      method: 'POST',
      url: '/v1/sessions/switch-tenant',
      payload: { tenantId: destino.tenantId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tenantId: destino.tenantId,
      tenantSlug: 'trocadestino',
      clerkOrgId: destino.clerkOrgId,
    })

    const trilha = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'session.tenant_switched' },
    })
    // Quem precisa ver a entrada é quem administra a base em que a pessoa entrou.
    expect(trilha.tenantId).toBe(destino.tenantId)
    expect(trilha.actorUserId).toBe(origem.userId)
  })

  it('AC-02: sem vínculo é 403, sem revelar se o estabelecimento existe', async () => {
    const origem = await givenTenant('semvinculoorigem')
    const alheio = await givenTenant('semvinculodestino')

    const response = await callApi({
      ...asAdmin(origem),
      method: 'POST',
      url: '/v1/sessions/switch-tenant',
      payload: { tenantId: alheio.tenantId },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().detail).toBe('Você não tem acesso a este estabelecimento')

    // A mesma resposta de um id que não existe em lugar nenhum.
    const inexistente = await callApi({
      ...asAdmin(origem),
      method: 'POST',
      url: '/v1/sessions/switch-tenant',
      payload: { tenantId: '2f1f4d3c-0000-4000-8000-0000000000ff' },
    })
    expect(inexistente.statusCode).toBe(403)
    expect(inexistente.json().detail).toBe(response.json().detail)
  })

  it('vale para quem ainda não tem estabelecimento aberto no token', async () => {
    const destino = await givenTenant('semorgnotoken')
    const recemChegado = await givenTeamMember(destino, 'RECEPTIONIST', 'recemchegado')

    // Quem acabou de aceitar um convite tem vínculo e ainda não tem Organization ativa
    // no token. A rota não exige tenant resolvido, e é justamente este o caso.
    const response = await callApi({
      ...asStranger(recemChegado.clerkUserId),
      method: 'POST',
      url: '/v1/sessions/switch-tenant',
      payload: { tenantId: destino.tenantId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().clerkOrgId).toBe(destino.clerkOrgId)
  })

  it('recusa vínculo suspenso — o gateway barraria a sessão logo depois', async () => {
    const origem = await givenTenant('suspensotrocaorigem')
    const destino = await givenTenant('suspensotrocadestino')
    await ownerPrisma.membership.create({
      data: {
        tenantId: destino.tenantId,
        userId: origem.userId,
        roleKey: 'RECEPTIONIST',
        status: 'SUSPENDED',
      },
    })

    const response = await callApi({
      ...asAdmin(origem),
      method: 'POST',
      url: '/v1/sessions/switch-tenant',
      payload: { tenantId: destino.tenantId },
    })

    expect(response.statusCode).toBe(403)
  })
})
