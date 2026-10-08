import { DEFAULT_TIMEZONE, addDays, todayIn } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRoleIn,
  callApi,
  closeHarness,
  givenPet,
  givenTenant,
  givenVet,
  ownerPrisma,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * A carteira de vacinação (MOD-PRONT-08).
 *
 * As datas são relativas a hoje no fuso padrão — o `givenTenant` deste módulo não cria
 * `tenant_settings`, e é contra esse relógio que o serviço decide "atrasada".
 */

let tenant: TenantFixture
let petId: string

const today = todayIn(DEFAULT_TIMEZONE)

const FORA = {
  origin: 'EXTERNAL',
  vaccineKey: 'V10',
  appliedAt: addDays(today, -30),
  nextDoseAt: addDays(today, 335),
  externalClinic: 'Clínica Bicho Feliz',
}

const AQUI = {
  origin: 'INTERNAL',
  vaccineKey: 'RABIES',
  appliedAt: today,
  nextDoseAt: addDays(today, 365),
  manufacturer: 'Zoetis',
  batch: 'L2026-091',
  batchExpiresAt: addDays(today, 180),
}

function registrar(payload: unknown, caller: Caller = asAdmin(tenant), pet = petId) {
  return callApi({ ...caller, method: 'POST', url: `/v1/pets/${pet}/vaccinations`, payload })
}

function carteira(caller: Caller = asAdmin(tenant), pet = petId) {
  return callApi({ ...caller, method: 'GET', url: `/v1/pets/${pet}/vaccinations` })
}

function anular(id: string, reason: string, caller: Caller = asAdmin(tenant)) {
  return callApi({
    ...caller,
    method: 'POST',
    url: `/v1/pets/${petId}/vaccinations/${id}/void`,
    payload: { reason },
  })
}

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  petId = await givenPet(tenant)
})

afterAll(closeHarness)

describe('MOD-PRONT-08 — registrar', () => {
  it('aplicada fora entra sem lote nem CRMV, com o rótulo do catálogo', async () => {
    const response = await registrar({ ...FORA, vaccineLabel: 'v-10 digitado' })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      origin: 'EXTERNAL',
      vaccineKey: 'V10',
      // O rótulo do formulário é ignorado: a carteira não tem duas grafias da mesma vacina.
      vaccineLabel: 'V10 (Polivalente)',
      batch: null,
      crmv: null,
      externalClinic: 'Clínica Bicho Feliz',
    })
  })

  it('AC-01: aplicada aqui grava lote e o CRMV de quem está logado, em fotografia', async () => {
    const vetId = await givenVet(tenant)

    const response = await registrar(AQUI)

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      origin: 'INTERNAL',
      vaccineLabel: 'Antirrábica',
      batch: 'L2026-091',
      vetName: 'Dra. Helena Prado',
      crmv: '12345/SP',
    })
    const row = await ownerPrisma.vaccination.findFirstOrThrow({ where: { petId } })
    expect(row.appliedBy).toBe(vetId)

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: tenant.tenantId, action: 'vaccination.created' },
    })
    expect(audit).not.toBeNull()
  })

  it('AC-02: lote vencido na data da aplicação é 422 ERR_PRONT_002', async () => {
    await givenVet(tenant)

    const response = await registrar({ ...AQUI, batchExpiresAt: addDays(today, -1) })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'ERR_PRONT_002' })
    expect(response.json().errors[0].field).toBe('batchExpiresAt')
    expect(await ownerPrisma.vaccination.count()).toBe(0)
  })

  it('aplicada aqui sem lote é recusada na validação', async () => {
    await givenVet(tenant)
    const { batch: _batch, ...semLote } = AQUI

    const response = await registrar(semLote)

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PRONT_002')
  })

  it('aplicada aqui sem ficha de profissional ligada ao usuário é 403 ERR_PRONT_009', async () => {
    const response = await registrar(AQUI)

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PRONT_009')
  })

  it('profissional sem CRMV não registra a dose aplicada aqui', async () => {
    await givenVet(tenant, { crmv: null, crmvState: null })

    const response = await registrar(AQUI)

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PRONT_009')
  })

  it('vacina de outra espécie é recusada; "Outra" exige o nome', async () => {
    const gato = await registrar({ ...FORA, vaccineKey: 'FELV' })
    expect(gato.statusCode).toBe(422)

    const semNome = await registrar({ ...FORA, vaccineKey: 'OTHER' })
    expect(semNome.statusCode).toBe(422)

    const outra = await registrar({ ...FORA, vaccineKey: 'OTHER', vaccineLabel: 'Coronavírus' })
    expect(outra.statusCode).toBe(201)
    expect(outra.json().vaccineLabel).toBe('Coronavírus')
  })

  it('próxima dose antes da aplicação e aplicação no futuro são recusadas', async () => {
    const antes = await registrar({ ...FORA, nextDoseAt: addDays(FORA.appliedAt, -1) })
    expect(antes.statusCode).toBe(422)

    const futuro = await registrar({ ...FORA, appliedAt: addDays(today, 2), nextDoseAt: null })
    expect(futuro.statusCode).toBe(422)
  })
})

describe('MOD-PRONT-08 — quem pode', () => {
  it('a recepção transcreve a carteira de papel, mas não assina a dose aplicada aqui', async () => {
    const recepcao = await asRoleIn(tenant, 'RECEPTIONIST')

    expect((await registrar(FORA, recepcao)).statusCode).toBe(201)

    const aqui = await registrar(AQUI, recepcao)
    expect(aqui.statusCode).toBe(403)
    expect(aqui.json().code).toBe('ERR_PRONT_003')
  })

  it('o banhista lê a carteira e não escreve nela', async () => {
    const banhista = await asRoleIn(tenant, 'BATHER')
    await registrar(FORA)

    const leitura = await carteira(banhista)
    expect(leitura.statusCode).toBe(200)
    expect(leitura.json().current).toHaveLength(1)

    expect((await registrar(FORA, banhista)).statusCode).toBe(403)
  })

  it('pet de outro estabelecimento é 404', async () => {
    const outro = await givenTenant('Outro Petshop')
    const petAlheio = await givenPet(outro, 'Rex')

    expect((await carteira(asAdmin(tenant), petAlheio)).statusCode).toBe(404)
    expect((await registrar(FORA, asAdmin(tenant), petAlheio)).statusCode).toBe(404)
  })
})

describe('MOD-PRONT-08 — o estado da carteira', () => {
  it('sem registro é UNKNOWN, e não "em dia"', async () => {
    const response = await carteira()
    expect(response.json()).toMatchObject({ status: 'UNKNOWN', current: [], history: [] })
  })

  it('AC-03: próxima dose vencida é OVERDUE, e o resumo clínico avisa sem bloquear', async () => {
    await registrar({
      ...FORA,
      appliedAt: addDays(today, -410),
      nextDoseAt: addDays(today, -45),
    })

    expect((await carteira()).json().status).toBe('OVERDUE')

    const summary = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${petId}/summary`,
    })
    expect(summary.json()).toMatchObject({
      vaccinationStatus: 'OVERDUE',
      overdueVaccines: [{ vaccineLabel: 'V10 (Polivalente)', daysOverdue: 45 }],
      blockingFlags: [],
    })
  })

  it('a dose nova supersede a vencida da mesma vacina', async () => {
    await registrar({ ...FORA, appliedAt: addDays(today, -410), nextDoseAt: addDays(today, -45) })
    await registrar(FORA)

    const body = (await carteira()).json()
    expect(body.status).toBe('UP_TO_DATE')
    expect(body.current).toHaveLength(1)
    expect(body.current[0].appliedAt).toBe(FORA.appliedAt)
    expect(body.history).toHaveLength(2)
  })

  it('vencendo nos próximos 30 dias é DUE_SOON', async () => {
    await registrar({ ...FORA, nextDoseAt: addDays(today, 20) })
    expect((await carteira()).json().status).toBe('DUE_SOON')
  })

  it('a vacina entra na linha do tempo do pet', async () => {
    await registrar(FORA)

    const timeline = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${petId}/timeline`,
    })
    const entry = timeline.json().entries.find((item: { kind: string }) => item.kind === 'VACCINATION')
    expect(entry).toMatchObject({ title: 'Vacina — V10 (Polivalente)', status: 'EXTERNAL' })
  })
})

describe('MOD-PRONT-08 — anular', () => {
  it('anula com motivo, sai da dose vigente e continua no histórico', async () => {
    const id = (await registrar(FORA)).json().id

    expect((await anular(id, 'curto')).statusCode).toBe(422)

    const response = await anular(id, 'Lançada no pet errado, era do irmão')
    expect(response.statusCode).toBe(200)
    expect(response.json().voidReason).toBe('Lançada no pet errado, era do irmão')

    const body = (await carteira()).json()
    expect(body).toMatchObject({ status: 'UNKNOWN', current: [] })
    expect(body.history).toHaveLength(1)

    expect((await anular(id, 'De novo, por engano')).statusCode).toBe(422)
  })

  it('a recepção não anula a dose assinada pelo veterinário', async () => {
    await givenVet(tenant)
    const id = (await registrar(AQUI)).json().id
    const recepcao = await asRoleIn(tenant, 'RECEPTIONIST')

    const response = await anular(id, 'A recepção achou que estava errada', recepcao)
    expect(response.statusCode).toBe(403)
  })
})
