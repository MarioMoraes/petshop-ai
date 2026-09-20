import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setSchedulingPort } from '../../src/modules/identity/scheduling-port.js'
import { identitySchedulingPort } from '../../src/modules/scheduling/identity-port.js'
import {
  asAdmin,
  asStranger,
  callApi,
  closeHarness,
  dubleDaAgenda,
  givenClerkUser,
  givenTeamMember,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  resetFakeClerk,
  resetMailer,
  type IdentityTenant,
} from './fixtures.js'

/**
 * RN-06 do MOD-IDENT — o espelho de `professionals`.
 *
 * "Ao atribuir papel GROOMER/BATHER/VET/DRIVER, o sistema cria/reativa o registro
 * correspondente em `professionals`." A regra estava no PRD, `membership.is_professional`
 * estava no schema e o evento `membership.papel_alterado` era publicado — **e nenhum
 * código escrevia a outra ponta**. O petshop que contratava um banhista dava o papel a
 * ele e não o encontrava na agenda.
 *
 * **A porta aqui é a de verdade**, e não um dublê: o que esta suíte precisa provar é
 * justamente que a ligação existe em produção — a lição do AC-02 de MOD-PET-05, que
 * ficou escrito, testado e inerte porque a porta só era ligada em teste. O único
 * cenário que dubla é o do rebaixamento com agenda futura, onde o que se verifica é a
 * guarda e não a agenda.
 */

beforeEach(async () => {
  await resetDatabase()
  resetFakeClerk()
  resetMailer()
  setSchedulingPort(identitySchedulingPort)
})

afterEach(() => {
  setSchedulingPort(identitySchedulingPort)
})

afterAll(closeHarness)

async function trocarPapel(session: IdentityTenant, membershipId: string, role: string) {
  return callApi({
    ...asAdmin(session),
    method: 'PATCH',
    url: `/v1/memberships/${membershipId}`,
    payload: { role },
  })
}

async function fichaDe(tenantId: string, userId: string) {
  return ownerPrisma.professional.findFirst({
    where: { tenantId, userId },
    include: { services: true, schedules: true },
  })
}

describe('o papel operacional abre a ficha na agenda', () => {
  it('promover a GROOMER cria o profissional ligado ao usuário, pronto para agendar', async () => {
    const session = await givenTenant('espelhocria')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Maria Banhista')

    // Antes: a pessoa está na equipe e não existe na agenda — o defeito que a fatia fecha.
    expect(await fichaDe(session.tenantId, member.userId)).toBeNull()

    const response = await trocarPapel(session, member.membershipId, 'GROOMER')
    expect(response.statusCode).toBe(200)

    const ficha = await fichaDe(session.tenantId, member.userId)
    expect(ficha).toMatchObject({
      displayName: 'Maria Banhista',
      roleKey: 'GROOMER',
      active: true,
      maxConcurrentPets: 1,
    })
    // A jornada nasce igual ao horário de funcionamento: seis dias, domingo fechado.
    expect(ficha?.schedules).toHaveLength(6)
    expect(ficha?.schedules.find((dia) => dia.weekday === 6)).toMatchObject({
      startsAtMin: 8 * 60,
      endsAtMin: 13 * 60,
    })
    expect(ficha?.schedules.some((dia) => dia.weekday === 0)).toBe(false)
    // E habilitada nos serviços que o provisionamento semeou: sem isso ela não
    // apareceria no assistente de marcar horário.
    const servicos = await ownerPrisma.service.count({ where: { tenantId: session.tenantId } })
    expect(servicos).toBeGreaterThan(0)
    expect(ficha?.services).toHaveLength(servicos)

    await ownerPrisma.auditLog.findFirstOrThrow({
      where: { tenantId: session.tenantId, action: 'professional.mirrored' },
    })
  })

  it('o motorista nasce sem serviço — ele não atende pet', async () => {
    const session = await givenTenant('espelhomotorista')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Carlos Motorista')

    await trocarPapel(session, member.membershipId, 'DRIVER')

    const ficha = await fichaDe(session.tenantId, member.userId)
    expect(ficha?.roleKey).toBe('DRIVER')
    // `NON_ATTENDING_ROLE_KEYS`: habilitá-lo em "Banho" o ofereceria como banhista.
    expect(ficha?.services).toHaveLength(0)
    // A jornada ele tem, porque é dela que sai a escala da corrida.
    expect(ficha?.schedules).toHaveLength(6)
  })

  it('trocar de um papel operacional para outro acerta a ficha em vez de abrir a segunda', async () => {
    const session = await givenTenant('espelhotroca')
    // Semeado como recepção: `givenTeamMember` grava o vínculo direto, sem passar pela
    // rota — é a troca de papel que abre a ficha, e trocar para o mesmo papel é no-op.
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Rita Vet')

    await trocarPapel(session, member.membershipId, 'BATHER')
    await trocarPapel(session, member.membershipId, 'VET')

    const fichas = await ownerPrisma.professional.findMany({
      where: { tenantId: session.tenantId, userId: member.userId },
    })
    expect(fichas).toHaveLength(1)
    expect(fichas[0]?.roleKey).toBe('VET')
  })

  it('quem entra pela porta do convite já entra na agenda', async () => {
    const admin = await givenTenant('espelhoconvite')
    const convite = (
      await callApi({
        ...asAdmin(admin),
        method: 'POST',
        url: '/v1/invitations',
        payload: { email: 'tosadora@exemplo.com', role: 'GROOMER' },
      })
    ).json()
    const convidado = givenClerkUser('tosadora@exemplo.com', 'Ana Tosadora')

    const aceite = await callApi({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: convite.inviteUrl.split('/convite/')[1] },
      ...asStranger(convidado),
    })
    expect(aceite.statusCode).toBe(200)

    const user = await ownerPrisma.user.findFirstOrThrow({ where: { clerkUserId: convidado } })
    const ficha = await fichaDe(admin.tenantId, user.id)
    expect(ficha).toMatchObject({ displayName: 'Ana Tosadora', roleKey: 'GROOMER', active: true })
  })
})

describe('a adoção do cadastro que já existia na agenda', () => {
  /** Um profissional cadastrado à mão na tela da agenda: sem login, como o §4 permite. */
  async function fichaSemDono(tenantId: string, displayName: string, roleKey = 'BATHER') {
    return ownerPrisma.professional.create({
      data: { tenantId, displayName, roleKey, userId: null },
    })
  }

  it('adota o cadastro sem dono de mesmo nome, sem acento e sem caixa', async () => {
    const session = await givenTenant('espelhoadota')
    const avulso = await fichaSemDono(session.tenantId, 'luis carlos')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Luís Carlos')

    await trocarPapel(session, member.membershipId, 'VET')

    const fichas = await ownerPrisma.professional.findMany({
      where: { tenantId: session.tenantId },
    })
    // Uma só: sem a adoção, "Luís Carlos" viraria dois — e não há fusão de
    // profissionais neste produto.
    expect(fichas).toHaveLength(1)
    expect(fichas[0]).toMatchObject({
      id: avulso.id,
      userId: member.userId,
      roleKey: 'VET',
      // O nome da agenda é preservado: quem o digitou foi o petshop.
      displayName: 'luis carlos',
    })
  })

  it('dois homônimos sem dono não adotam nenhum — escolher o primeiro é pendurar a agenda na pessoa errada', async () => {
    const session = await givenTenant('espelhohomonimo')
    await fichaSemDono(session.tenantId, 'Maria Silva')
    await fichaSemDono(session.tenantId, 'maria silva')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Maria Silva')

    await trocarPapel(session, member.membershipId, 'GROOMER')

    const fichas = await ownerPrisma.professional.findMany({
      where: { tenantId: session.tenantId },
    })
    expect(fichas).toHaveLength(3)
    expect(fichas.filter((ficha) => ficha.userId === member.userId)).toHaveLength(1)
  })

  it('não adota o cadastro que já tem outro dono', async () => {
    const session = await givenTenant('espelhodono')
    const primeiro = await givenTeamMember(session, 'RECEPTIONIST', 'João Duplo')
    await trocarPapel(session, primeiro.membershipId, 'GROOMER')

    // O segundo homônimo entra com outro e-mail (a chave do usuário) e o mesmo nome.
    const segundo = await givenTeamMember(session, 'RECEPTIONIST', 'joao-duplo-2')
    await ownerPrisma.user.update({
      where: { id: segundo.userId },
      data: { fullName: 'João Duplo' },
    })
    await trocarPapel(session, segundo.membershipId, 'GROOMER')

    const fichas = await ownerPrisma.professional.findMany({
      where: { tenantId: session.tenantId },
    })
    expect(fichas).toHaveLength(2)
  })
})

describe('o papel que sai fecha a ficha', () => {
  it('rebaixar para RECEPTIONIST desativa a ficha, sem apagá-la', async () => {
    const session = await givenTenant('espelhorebaixa')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Paulo Banhista')
    await trocarPapel(session, member.membershipId, 'BATHER')

    const response = await trocarPapel(session, member.membershipId, 'RECEPTIONIST')
    expect(response.statusCode).toBe(200)

    const ficha = await fichaDe(session.tenantId, member.userId)
    // Inativa, não apagada: o atendimento de março aponta para esta linha.
    expect(ficha?.active).toBe(false)
    expect(ficha?.deletedAt).toBeNull()

    await ownerPrisma.auditLog.findFirstOrThrow({
      where: { tenantId: session.tenantId, action: 'professional.mirror_dropped' },
    })
  })

  it('promover de novo reativa a mesma ficha', async () => {
    const session = await givenTenant('espelhoreativa')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Paula Volta')
    await trocarPapel(session, member.membershipId, 'BATHER')
    const antes = await fichaDe(session.tenantId, member.userId)
    await trocarPapel(session, member.membershipId, 'RECEPTIONIST')

    await trocarPapel(session, member.membershipId, 'GROOMER')

    const depois = await fichaDe(session.tenantId, member.userId)
    expect(depois?.id).toBe(antes?.id)
    expect(depois?.active).toBe(true)
    expect(depois?.roleKey).toBe('GROOMER')
    // Reativada, e não recriada: a jornada ajustada pelo petshop continua lá.
    expect(depois?.schedules).toHaveLength(6)
  })

  it('rebaixar quem tem agenda futura é recusado com a lista, e o papel não muda', async () => {
    const session = await givenTenant('espelhoagenda')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Sara Ocupada')
    await trocarPapel(session, member.membershipId, 'GROOMER')

    setSchedulingPort(
      dubleDaAgenda({
        async listFutureProfessionalAppointments() {
          return [
            {
              id: '2f1f4d3c-0000-4000-8000-000000000009',
              startsAt: '2026-10-01T13:00:00.000Z',
              petName: 'Rex',
              serviceLabel: 'Banho e tosa',
            },
          ]
        },
      }),
    )

    const response = await trocarPapel(session, member.membershipId, 'RECEPTIONIST')

    expect(response.statusCode).toBe(409)
    expect(response.json().appointments).toHaveLength(1)
    // A transação inteira volta: o papel **não** mudou, senão a recusa deixaria a
    // pessoa sem o papel e com o banho de sábado no nome dela.
    const membership = await ownerPrisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId },
    })
    expect(membership.roleKey).toBe('GROOMER')
  })

  it('remover da equipe desativa a ficha', async () => {
    const session = await givenTenant('espelhoremove')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Tiago Sai')
    await trocarPapel(session, member.membershipId, 'VET')

    const response = await callApi({
      ...asAdmin(session),
      method: 'DELETE',
      url: `/v1/memberships/${member.membershipId}`,
    })
    expect(response.statusCode).toBe(200)

    const ficha = await fichaDe(session.tenantId, member.userId)
    expect(ficha?.active).toBe(false)
  })

  it('suspender o acesso não mexe na ficha — a agenda de sábado é de quem volta na quinta', async () => {
    const session = await givenTenant('espelhosuspende')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Ivo Licença')
    await trocarPapel(session, member.membershipId, 'GROOMER')

    await callApi({
      ...asAdmin(session),
      method: 'PATCH',
      url: `/v1/memberships/${member.membershipId}/status`,
      payload: { status: 'SUSPENDED' },
    })

    const ficha = await fichaDe(session.tenantId, member.userId)
    expect(ficha?.active).toBe(true)
  })
})

describe('a RN-07 deixa de ser inerte', () => {
  /**
   * A guarda da remoção pergunta por `professionals.user_id` — e **ninguém preenchia essa
   * coluna**. A regra respondia sempre "não há agendamento" e deixava remover qualquer
   * um. Com o espelho, a pergunta passa a achar a pessoa.
   */
  it('o profissional criado pelo papel é quem a guarda da remoção encontra', async () => {
    const session = await givenTenant('rn07liga')
    const member = await givenTeamMember(session, 'RECEPTIONIST', 'Bruno Cheio')
    await trocarPapel(session, member.membershipId, 'GROOMER')

    const ficha = await fichaDe(session.tenantId, member.userId)
    expect(ficha?.userId).toBe(member.userId)
  })
})
