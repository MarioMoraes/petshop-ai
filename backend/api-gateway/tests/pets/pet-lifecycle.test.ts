import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setSchedulingPort } from '../../src/modules/pets/scheduling-port.js'
import {
  asAdmin,
  asRole,
  callApi,
  catalogIds,
  closeHarness,
  givenTenant,
  givenTutor,
  ownerPrisma,
  resetDatabase,
  type CatalogFixture,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-PET-05 (transferência), MOD-PET-07 (histórico de peso) e MOD-PET-08 (óbito),
 * pelos critérios de aceite do PRD pets_03 §3.
 *
 * As três operações mudam o estado do pet de forma que a edição comum não pode
 * desfazer, e é por isso que cada uma tem rota própria: o efeito colateral — vínculo
 * encerrado, campanha suprimida, alerta clínico — não pode sair de um PATCH.
 */

let tenant: TenantFixture
let catalog: CatalogFixture
let tutorId: string
let otherTutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  catalog = await catalogIds()
  tutorId = await givenTutor(tenant, 'Maria Silva')
  otherTutorId = await givenTutor(tenant, 'Carlos Souza')
})

afterEach(() => {
  setSchedulingPort(null)
})

afterAll(closeHarness)

async function givenPet(payload: Record<string, unknown> = {}): Promise<string> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/pets',
    payload: {
      name: 'Thor',
      speciesId: catalog.speciesDogId,
      sizeId: catalog.sizeLargeId,
      sex: 'MALE',
      birthDate: '2021-03-10',
      tutors: [{ tutorId, role: 'PRIMARY' }],
      ...payload,
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json().id as string
}

const CONFIRMATION = 'CONFIRMO_A_TRANSFERENCIA'

describe('MOD-PET-05 — transferência de titularidade', () => {
  it('AC-01: encerra os vínculos, promove o novo tutor e registra o motivo', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: {
        toTutorId: otherTutorId,
        reason: 'ADOPTION',
        notes: 'Adotado pela família Souza',
        effectiveDate: '2026-08-20',
        confirmation: CONFIRMATION,
      },
    })

    expect(response.statusCode).toBe(200)
    const pet = response.json()
    expect(pet.tutors).toHaveLength(1)
    expect(pet.tutors[0]).toMatchObject({ tutorId: otherTutorId, role: 'PRIMARY' })

    const log = await ownerPrisma.petTransferLog.findFirstOrThrow({ where: { petId } })
    expect(log).toMatchObject({ fromTutorId: tutorId, toTutorId: otherTutorId, reason: 'ADOPTION' })

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { entityId: petId, action: 'pet.transferred' },
    })
    expect(audit).not.toBeNull()
  })

  it('AC-01/RN-06: o histórico clínico continua no mesmo pet', async () => {
    const petId = await givenPet({ weightKg: 30 })
    const before = await ownerPrisma.petWeight.count({ where: { petId } })

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'SALE', confirmation: CONFIRMATION },
    })

    // As pesagens são do animal, não de quem responde por ele.
    expect(await ownerPrisma.petWeight.count({ where: { petId } })).toBe(before)
  })

  it('AC-03/RN-07: o tutor anterior perde o pet, mas o vínculo fica como histórico', async () => {
    const petId = await givenPet()

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'ADOPTION', confirmation: CONFIRMATION },
    })

    const oldTutorPets = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets?tutorId=${tutorId}`,
    })
    expect(oldTutorPets.json().total).toBe(0)

    const link = await ownerPrisma.petTutor.findFirstOrThrow({ where: { petId, tutorId } })
    expect(link.unlinkedAt).not.toBeNull()

    const newTutorPets = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets?tutorId=${otherTutorId}`,
    })
    expect(newTutorPets.json().total).toBe(1)
  })

  it('promove o responsável secundário que já estava vinculado', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/tutors`,
      payload: { tutorId: otherTutorId, role: 'SECONDARY', relationship: 'Cônjuge' },
    })

    // O caso do casal que se separa: quem já cuidava do pet passa a responder por ele.
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'OTHER', confirmation: CONFIRMATION },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().tutors).toHaveLength(1)
    expect(response.json().tutors[0]).toMatchObject({ tutorId: otherTutorId, role: 'PRIMARY' })

    // O vínculo antigo dele vira histórico em vez de colidir com o novo.
    const links = await ownerPrisma.petTutor.findMany({ where: { petId, tutorId: otherTutorId } })
    expect(links).toHaveLength(2)
    expect(links.filter((link) => link.unlinkedAt === null)).toHaveLength(1)
  })

  it('AC-02: agendamento futuro bloqueia a transferência e a resposta diz quais são', async () => {
    const petId = await givenPet()

    // MOD-AGENDA ainda não existe; a porta é o que permite a regra existir antes dele.
    setSchedulingPort({
      async listFuturePetAppointments() {
        return [
          {
            id: '2f1f4d3c-0000-4000-8000-000000000001',
            startsAt: '2026-09-01T13:00:00.000Z',
            serviceLabel: 'Banho e tosa',
            tutorId,
          },
        ]
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'ADOPTION', confirmation: CONFIRMATION },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PET_005')
    expect(response.json().appointments).toHaveLength(1)
    expect(response.json().appointments[0]).toMatchObject({ serviceLabel: 'Banho e tosa' })

    // Bloqueou antes de encerrar qualquer vínculo: o pet segue com o tutor de origem.
    const links = await ownerPrisma.petTutor.findMany({ where: { petId, unlinkedAt: null } })
    expect(links).toHaveLength(1)
    expect(links[0]?.tutorId).toBe(tutorId)
    expect(await ownerPrisma.petTransferLog.count({ where: { petId } })).toBe(0)
  })

  it('AC-02: sem agendamento futuro, a transferência segue', async () => {
    const petId = await givenPet()
    setSchedulingPort({
      async listFuturePetAppointments() {
        return []
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'ADOPTION', confirmation: CONFIRMATION },
    })

    expect(response.statusCode).toBe(200)
  })

  it('recusa transferir para quem já é o responsável principal', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: tutorId, reason: 'CORRECTION', confirmation: CONFIRMATION },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PET_004')
  })

  it('recusa a transferência sem a confirmação literal', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'ADOPTION', confirmation: 'sim' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('o log de transferência é append-only', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'ADOPTION', confirmation: CONFIRMATION },
    })

    const log = await ownerPrisma.petTransferLog.findFirstOrThrow({ where: { petId } })
    await expect(
      ownerPrisma.petTransferLog.update({ where: { id: log.id }, data: { reason: 'OTHER' } }),
    ).rejects.toThrow()
  })

  it('o histórico de titularidade é legível na tela do pet', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'TUTOR_DEATH', confirmation: CONFIRMATION },
    })

    const response = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/transfers` })

    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject({
      fromTutorName: 'Maria Silva',
      toTutorName: 'Carlos Souza',
      reason: 'TUTOR_DEATH',
    })
  })

  it('a recepção não transfere titularidade', async () => {
    const petId = await givenPet()

    // A matriz dá `pet:read`, `pet:create` e `pet:update` à recepção, e **não**
    // `pet:manage_lifecycle` — que é o gate da transferência.
    const response = await callApi({
      ...(await asRole(tenant, 'RECEPTIONIST')),
      method: 'POST',
      url: `/v1/pets/${petId}/transfer`,
      payload: { toTutorId: otherTutorId, reason: 'ADOPTION', confirmation: CONFIRMATION },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('MOD-PET-07 — histórico de peso', () => {
  it('registra a pesagem, atualiza o peso atual e devolve a variação', async () => {
    const petId = await givenPet({ weightKg: 30 })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 31.5 },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ weightKg: 31.5, previousWeightKg: 30, alert: false })
    expect(response.json().variationPercent).toBeCloseTo(5, 1)

    const pet = await ownerPrisma.pet.findUniqueOrThrow({ where: { id: petId } })
    expect(Number(pet.weightKg)).toBe(31.5)
  })

  it('RN-11: queda acima de 15% dentro de 60 dias vira alerta', async () => {
    const petId = await givenPet({ weightKg: 30 })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 24 },
    })

    expect(response.json()).toMatchObject({ variationPercent: -20, alert: true })
  })

  it('RN-11: a mesma queda espalhada por mais de 60 dias não alerta', async () => {
    const petId = await givenPet({ weightKg: 30 })

    // A pesagem antiga entra retroativa, longe da janela clínica.
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 40, measuredAt: old },
    })

    const series = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/weights` })
    const [current] = series.json() as { weightKg: number; variationPercent: number; alert: boolean }[]
    expect(current).toMatchObject({ weightKg: 30, variationPercent: -25, alert: false })
  })

  it('RN-10: pesagem retroativa entra na série sem mexer no peso atual', async () => {
    const petId = await givenPet({ weightKg: 30 })
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 28, measuredAt: yesterday },
    })

    const pet = await ownerPrisma.pet.findUniqueOrThrow({ where: { id: petId } })
    expect(Number(pet.weightKg)).toBe(30)
    expect(await ownerPrisma.petWeight.count({ where: { petId } })).toBe(2)
  })

  it('a série sai da mais recente para a mais antiga, com a comparação de cada ponto', async () => {
    const petId = await givenPet({ weightKg: 30 })
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 32 },
    })

    const response = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/weights` })

    const series = response.json() as { weightKg: number; previousWeightKg: number | null }[]
    expect(series.map((point) => point.weightKg)).toEqual([32, 30])
    expect(series[0]?.previousWeightKg).toBe(30)
    expect(series[1]?.previousWeightKg).toBeNull()
  })

  it('o banhista pesa sem poder editar o cadastro', async () => {
    const petId = await givenPet()
    // `BATHER` tem `pet:weigh` e não tem `pet:update`: é a distinção que este teste
    // exercita, e ela agora vem da matriz em vez de uma lista escrita aqui.
    const banhista = await asRole(tenant, 'BATHER')

    const weighed = await callApi({
      ...banhista,
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 12 },
    })
    expect(weighed.statusCode).toBe(201)

    const edited = await callApi({
      ...banhista,
      method: 'PATCH',
      url: `/v1/pets/${petId}`,
      payload: { name: 'Outro Nome' },
    })
    expect(edited.statusCode).toBe(403)
  })

  it('recusa pesagem no futuro', async () => {
    const petId = await givenPet()
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 12, measuredAt: tomorrow },
    })

    expect(response.statusCode).toBe(422)
  })
})

describe('MOD-PET-08 — óbito', () => {
  it('AC-01: registra o óbito e o pet sai das listagens operacionais', async () => {
    const petId = await givenPet()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-08-10' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'DECEASED', deceasedAt: '2026-08-10' })

    const list = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/pets' })
    expect(list.json().total).toBe(0)

    // Continua encontrável quando se procura por ele de propósito.
    const explicit = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/pets?status=DECEASED',
    })
    expect(explicit.json().total).toBe(1)
  })

  it('AC-02: o pet falecido fica fora do público de campanha de aniversário', async () => {
    const petId = await givenPet({ birthDate: '2021-08-28' })
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-08-10' },
    })

    // O índice de aniversário (`idx_pets_birthday`) filtra `status = 'ACTIVE'`; a
    // consulta do MOD-CRM usa o mesmo filtro, e é isso que este teste protege.
    const aniversariantes = await ownerPrisma.pet.count({
      where: { tenantId: tenant.tenantId, status: 'ACTIVE', birthDate: { not: null } },
    })
    expect(aniversariantes).toBe(0)
  })

  it('AC-03: o administrador reverte o óbito com justificativa, e a trilha guarda o motivo', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-08-10' },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death/reversal`,
      payload: { justification: 'Registro feito no pet errado pela recepção' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ACTIVE', deceasedAt: null })

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { entityId: petId, action: 'pet.deceased_reverted' },
    })
    expect(JSON.stringify(audit.after)).toContain('recepção')
  })

  it('AC-03: passados 30 dias do registro, a reversão exige suporte', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-07-01' },
    })

    // Envelhece o registro: a janela conta do lançamento, não da data do óbito.
    await ownerPrisma.pet.update({
      where: { id: petId },
      data: { deceasedRecordedAt: new Date(Date.now() - 31 * 86_400_000) },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death/reversal`,
      payload: { justification: 'Erro percebido tarde demais' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PET_005')
  })

  it('a reversão exige justificativa com conteúdo', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-08-10' },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death/reversal`,
      payload: { justification: 'erro' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('recusa data de óbito no futuro e anterior ao nascimento', async () => {
    const petId = await givenPet({ birthDate: '2021-03-10' })
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

    const future = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: tomorrow },
    })
    expect(future.statusCode).toBe(422)

    const beforeBirth = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2020-01-01' },
    })
    expect(beforeBirth.statusCode).toBe(422)
  })

  it('o pet falecido não aceita edição comum nem nova pesagem', async () => {
    const petId = await givenPet()
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-08-10' },
    })

    const edited = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}`,
      payload: { name: 'Thor II' },
    })
    expect(edited.statusCode).toBe(409)

    const weighed = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/weights`,
      payload: { weightKg: 20 },
    })
    expect(weighed.statusCode).toBe(409)
  })

  it('a recepção registra o óbito, mas só o administrador reverte', async () => {
    const petId = await givenPet()
    // `pet:update` registra o óbito; reverter exige `pet:manage_lifecycle`, que a
    // recepção não tem.
    const recepcao = await asRole(tenant, 'RECEPTIONIST')

    const registered = await callApi({
      ...recepcao,
      method: 'POST',
      url: `/v1/pets/${petId}/death`,
      payload: { deceasedAt: '2026-08-10' },
    })
    expect(registered.statusCode).toBe(200)

    const reverted = await callApi({
      ...recepcao,
      method: 'POST',
      url: `/v1/pets/${petId}/death/reversal`,
      payload: { justification: 'Registrado no pet errado' },
    })
    expect(reverted.statusCode).toBe(403)
  })
})
