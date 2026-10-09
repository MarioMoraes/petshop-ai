import { DEFAULT_TIMEZONE, addDays, todayIn } from '@petshop/shared-types'
import { withTenant } from '@petshop/db'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCipher } from '../../src/modules/records/crypto.js'
import { overdueVaccines, overdueVaccinesList } from '../../src/modules/records/overdue-vaccines.js'
import { PdfUnavailableError, setPdfPort } from '../../src/modules/records/pdf-port.js'
import {
  asAdmin,
  asRoleIn,
  callApi,
  closeHarness,
  givenPet,
  givenTenant,
  givenTutor,
  linkTutor,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'

/**
 * Pets com vacina atrasada no Início.
 *
 * O eixo é a regra ser a da carteira: só a dose **vigente** de cada vacina conta — a dose
 * nova supersede a velha, a anulada não existe, e "Outra" agrupa pelo nome —, e só em
 * pet ativo. Datas relativas a hoje no fuso padrão, como em `vaccinations.test.ts`.
 */

let tenant: TenantFixture

const today = todayIn(DEFAULT_TIMEZONE)

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

function dose(
  petId: string,
  vaccineKey: string,
  appliedAt: string,
  nextDoseAt: string | null,
  extra: { vaccineLabel?: string; voidedAt?: Date } = {},
) {
  return ownerPrisma.vaccination.create({
    data: {
      tenantId: tenant.tenantId,
      petId,
      origin: 'EXTERNAL',
      vaccineKey,
      vaccineLabel: extra.vaccineLabel ?? vaccineKey,
      appliedAt: new Date(appliedAt),
      nextDoseAt: nextDoseAt ? new Date(nextDoseAt) : null,
      voidedAt: extra.voidedAt ?? null,
      voidReason: extra.voidedAt ? 'Lançada no pet errado' : null,
    },
  })
}

describe('pets com vacina atrasada', () => {
  it('conta a dose vigente de cada vacina, em pet ativo', async () => {
    // Duas vacinas vencidas: um pet, duas doses.
    const thor = await givenPet(tenant, 'Thor')
    await dose(thor, 'V10', addDays(today, -400), addDays(today, -35))
    await dose(thor, 'RABIES', addDays(today, -380), addDays(today, -15))

    // A V10 de 2025 venceu, mas a de 2026 já foi lançada: em dia.
    const rex = await givenPet(tenant, 'Rex')
    await dose(rex, 'V10', addDays(today, -400), addDays(today, -35))
    await dose(rex, 'V10', addDays(today, -20), addDays(today, 345))

    // A dose nova foi anulada: a velha volta a ser a vigente, e está vencida.
    const mel = await givenPet(tenant, 'Mel')
    await dose(mel, 'V10', addDays(today, -400), addDays(today, -35))
    await dose(mel, 'V10', addDays(today, -20), addDays(today, 345), { voidedAt: new Date() })

    // "Outra" agrupa pelo nome, sem caixa nem espaço: a de agora supersede a velha.
    const bidu = await givenPet(tenant, 'Bidu')
    await dose(bidu, 'OTHER', addDays(today, -400), addDays(today, -35), {
      vaccineLabel: 'Leishmaniose',
    })
    await dose(bidu, 'OTHER', addDays(today, -10), addDays(today, 355), {
      vaccineLabel: ' leishmaniose ',
    })

    // Vence hoje não está atrasada; dose única não vence.
    const nina = await givenPet(tenant, 'Nina')
    await dose(nina, 'V10', addDays(today, -365), today)
    await dose(nina, 'RABIES', addDays(today, -365), null)

    // Inativo é o cliente que já não vem.
    const pipoca = await givenPet(tenant, 'Pipoca')
    await dose(pipoca, 'V10', addDays(today, -400), addDays(today, -35))
    await ownerPrisma.pet.update({ where: { id: pipoca }, data: { status: 'INACTIVE' } })

    expect(await overdueVaccines(tenant.tenantId)).toEqual({ today, pets: 2, doses: 3 })
  })

  it('responde pela rota a quem lê o resumo, e recusa o banhista', async () => {
    const petId = await givenPet(tenant)
    await dose(petId, 'V10', addDays(today, -400), addDays(today, -35))

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/records/reports/overdue-vaccines',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ today, pets: 1, doses: 1 })

    const recepcao = await asRoleIn(tenant, 'RECEPTIONIST')
    const permitido = await callApi({
      ...recepcao,
      method: 'GET',
      url: '/v1/records/reports/overdue-vaccines',
    })
    expect(permitido.statusCode).toBe(200)

    const banhista = await asRoleIn(tenant, 'BATHER')
    const negado = await callApi({
      ...banhista,
      method: 'GET',
      url: '/v1/records/reports/overdue-vaccines',
    })
    expect(negado.statusCode).toBe(403)
  })
})

describe('a lista impressa', () => {
  let rendered: string[]
  let failWith: Error | null

  beforeEach(() => {
    rendered = []
    failWith = null
    setPdfPort({
      async render(html) {
        if (failWith) throw failWith
        rendered.push(html)
        return Buffer.from('%PDF-1.4 dublê')
      },
    })
  })

  afterEach(() => setPdfPort(null))

  async function tutorComTelefone(name: string, phone: string, socialName?: string) {
    const tutorId = await givenTutor(tenant, name)
    await withTenant(tenant.tenantId, async (tx) => {
      const cipher = await openCipher(tx, tenant.tenantId)
      await tx.tutor.update({
        where: { id: tutorId },
        data: { phoneEncrypted: cipher.encrypt(phone), socialName: socialName ?? null },
      })
    })
    return tutorId
  }

  it('agrupa por pet, com o dono principal e o atraso mais antigo primeiro', async () => {
    const thor = await givenPet(tenant, 'Thor')
    await linkTutor(tenant, thor, await tutorComTelefone('Ana Souza', '+5511987654321'))
    await dose(thor, 'V10', addDays(today, -400), addDays(today, -10))
    await dose(thor, 'RABIES', addDays(today, -380), addDays(today, -3), {
      vaccineLabel: 'Antirrábica',
    })

    // Nome social é como o tutor é chamado; o atraso dela é o mais antigo da lista.
    const mel = await givenPet(tenant, 'Mel')
    await linkTutor(tenant, mel, await tutorComTelefone('João Lima', '+551132654321', 'Joana Lima'))
    await dose(mel, 'V10', addDays(today, -500), addDays(today, -45))

    // Sem tutor principal, o pet entra assim mesmo.
    const bidu = await givenPet(tenant, 'Bidu')
    await dose(bidu, 'V10', addDays(today, -400), addDays(today, -1))

    // Em dia: não entra.
    const nina = await givenPet(tenant, 'Nina')
    await dose(nina, 'V10', addDays(today, -10), addDays(today, 355))

    const list = await overdueVaccinesList(tenant.tenantId)

    expect(list).toMatchObject({ today, doses: 4, truncated: false })
    expect(list.pets).toEqual([
      expect.objectContaining({
        petName: 'Mel',
        tutorName: 'Joana Lima',
        phone: '+551132654321',
        vaccines: [{ label: 'V10', nextDoseAt: addDays(today, -45), daysOverdue: 45 }],
      }),
      expect.objectContaining({
        petName: 'Thor',
        tutorName: 'Ana Souza',
        phone: '+5511987654321',
        vaccines: [
          { label: 'V10', nextDoseAt: addDays(today, -10), daysOverdue: 10 },
          { label: 'Antirrábica', nextDoseAt: addDays(today, -3), daysOverdue: 3 },
        ],
      }),
      expect.objectContaining({ petName: 'Bidu', tutorName: null, phone: null }),
    ])
  })

  it('a rota devolve o PDF para abrir, com o texto digitado escapado', async () => {
    const petId = await givenPet(tenant, '<b>Rex</b>')
    await linkTutor(tenant, petId, await tutorComTelefone('Ana Souza', '+5511987654321'))
    await dose(petId, 'OTHER', addDays(today, -400), addDays(today, -30), {
      vaccineLabel: 'Giárdia <script>',
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/records/reports/overdue-vaccines/pdf',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toBe(
      `inline; filename="vacinas-atrasadas-${today}.pdf"`,
    )
    expect(response.headers['cache-control']).toBe('no-store')

    const html = rendered[0] ?? ''
    expect(html).toContain('&lt;b&gt;Rex&lt;/b&gt;')
    expect(html).toContain('Giárdia &lt;script&gt;')
    expect(html).toContain('(11) 98765-4321')
    expect(html).toContain('30 dias')
  })

  it('sem Gotenberg, responde o erro de documento indisponível', async () => {
    failWith = new PdfUnavailableError('fora do ar')

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/records/reports/overdue-vaccines/pdf',
    })
    expect(response.statusCode).not.toBe(200)
    expect(response.json()).toMatchObject({ code: 'ERR_DOC_005' })
  })

  it('o banhista não abre a lista', async () => {
    const banhista = await asRoleIn(tenant, 'BATHER')
    const negado = await callApi({
      ...banhista,
      method: 'GET',
      url: '/v1/records/reports/overdue-vaccines/pdf',
    })
    expect(negado.statusCode).toBe(403)
  })
})
