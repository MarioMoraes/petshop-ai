import { DEFAULT_TIMEZONE, addDays, todayIn } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  chave,
  closeHarness,
  emDias,
  givenAttendance,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type AttendanceFixture,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * A vacina aplicada aqui baixa a dose do estoque (MOD-PRONT-08 × MOD-ESTOQUE).
 *
 * O eixo é a carteira e o estoque contarem a mesma dose uma vez só: com `lotId`, o lote
 * e a validade gravados são os do lote e uma unidade sai dele; anular a vacina devolve;
 * e a vacina ligada a um atendimento que já lançou o lote não baixa de novo.
 */

let fixture: TenantFixture
let admin: Caller
let atendimento: AttendanceFixture

const hoje = todayIn(DEFAULT_TIMEZONE)

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  admin = asAdmin(fixture)
  atendimento = await givenAttendance(fixture)
  await ownerPrisma.petTutor.create({
    data: {
      tenantId: fixture.tenantId,
      petId: atendimento.petId,
      tutorId: atendimento.tutorId,
      role: 'PRIMARY',
    },
  })
  // A vacina aplicada aqui é assinada por quem está logado: o administrador da suíte
  // é também o veterinário.
  await ownerPrisma.professional.create({
    data: {
      tenantId: fixture.tenantId,
      displayName: 'Dra. Helena Prado',
      roleKey: 'VET',
      userId: fixture.userId,
      crmv: '12345',
      crmvState: 'SP',
    },
  })
})

afterAll(closeHarness)

async function vacinaNoEstoque(batchCode: string | null = 'L2026-091', expiresAt = emDias(180)) {
  const produto = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/products',
    payload: { name: 'Vacina V10', kind: 'SUPPLY', tracksExpiry: batchCode !== null },
  })
  expect(produto.statusCode, produto.body).toBe(201)
  const entrada = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/inventory/entries',
    payload: {
      productId: produto.json().id,
      quantity: '10',
      idempotencyKey: chave(),
      ...(batchCode ? { batchCode, expiresAt } : {}),
    },
  })
  expect(entrada.statusCode, entrada.body).toBe(201)
  return entrada.json().lot.id as string
}

async function saldo(lotId: string): Promise<string> {
  return (
    await ownerPrisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })
  ).quantityOnHand.toString()
}

function registrar(extra: Record<string, unknown>) {
  return callApi({
    ...admin,
    method: 'POST',
    url: `/v1/pets/${atendimento.petId}/vaccinations`,
    payload: {
      origin: 'INTERNAL',
      vaccineKey: 'V10',
      appliedAt: hoje,
      nextDoseAt: addDays(hoje, 365),
      manufacturer: 'Zoetis',
      // O que o formulário mandar é ignorado quando há lote do estoque.
      batch: 'DIGITADO',
      batchExpiresAt: addDays(hoje, 30),
      ...extra,
    },
  })
}

describe('a dose aplicada aqui sai do estoque', () => {
  it('baixa uma unidade, e a carteira grava o lote e a validade do estoque', async () => {
    const lotId = await vacinaNoEstoque('L2026-091', emDias(180))

    const resposta = await registrar({ lotId })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(resposta.json()).toMatchObject({ batch: 'L2026-091', batchExpiresAt: emDias(180) })
    expect(await saldo(lotId)).toBe('9')

    // O movimento aponta a vacina, o pet e o dono — é o que o rastreio do lote lê.
    const movimento = await ownerPrisma.stockMovement.findFirstOrThrow({
      where: { lotId, sourceType: 'VACCINATION' },
    })
    expect(movimento).toMatchObject({
      type: 'CONSUMPTION_OUT',
      sourceId: resposta.json().id,
      petId: atendimento.petId,
      tutorId: atendimento.tutorId,
    })

    const rastreio = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/inventory/lots/${lotId}/trace`,
    })
    expect(rastreio.json().entries).toEqual([
      expect.objectContaining({ petName: 'Thor', tutorName: 'Ana Souza', quantity: '1' }),
    ])
  })

  it('sem lote, a vacina é registrada como antes e o estoque não muda', async () => {
    const lotId = await vacinaNoEstoque()

    const resposta = await registrar({})

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(resposta.json()).toMatchObject({ batch: 'DIGITADO' })
    expect(await saldo(lotId)).toBe('10')
  })

  it('lote vencido na data da aplicação é recusado, e nada é gravado', async () => {
    const lotId = await vacinaNoEstoque('L-VELHO', emDias(-1))

    const resposta = await registrar({ lotId })

    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().code).toBe('ERR_INV_011')
    expect(await saldo(lotId)).toBe('10')
    expect(await ownerPrisma.vaccination.count()).toBe(0)
  })

  it('lote sem código não serve de rastreio para a carteira', async () => {
    const lotId = await vacinaNoEstoque(null)

    const resposta = await registrar({ lotId })

    expect(resposta.statusCode).toBe(422)
    expect(resposta.json().detail).toContain('não tem código de lote')
    expect(await saldo(lotId)).toBe('10')
  })

  it('a dose que o atendimento já baixou não sai de novo', async () => {
    const lotId = await vacinaNoEstoque()
    const produto = await ownerPrisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })
    const usado = await callApi({
      ...admin,
      method: 'PATCH',
      url: `/v1/attendances/${atendimento.attendanceId}`,
      payload: {
        items: [
          {
            id: atendimento.itemId,
            productsUsed: [
              { name: 'Vacina V10', productId: produto.productId, lotId, quantity: '1' },
            ],
          },
        ],
      },
    })
    expect(usado.statusCode, usado.body).toBe(200)
    expect(await saldo(lotId)).toBe('9')

    const resposta = await registrar({ lotId, attendanceId: atendimento.attendanceId })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(resposta.json()).toMatchObject({ batch: 'L2026-091' })
    expect(await saldo(lotId)).toBe('9')

    // E anular a vacina não devolve o que ela não tirou.
    const anulada = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/pets/${atendimento.petId}/vaccinations/${resposta.json().id}/void`,
      payload: { reason: 'Lançada em duplicidade' },
    })
    expect(anulada.statusCode, anulada.body).toBe(200)
    expect(await saldo(lotId)).toBe('9')
  })

  it('anular a vacina devolve a dose ao lote', async () => {
    const lotId = await vacinaNoEstoque()
    const criada = await registrar({ lotId })
    expect(await saldo(lotId)).toBe('9')

    const anulada = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/pets/${atendimento.petId}/vaccinations/${criada.json().id}/void`,
      payload: { reason: 'Registrada no pet errado' },
    })

    expect(anulada.statusCode, anulada.body).toBe(200)
    expect(await saldo(lotId)).toBe('10')
    const devolucao = await ownerPrisma.stockMovement.findFirstOrThrow({
      where: { lotId, type: 'VOID_RETURN' },
    })
    expect(devolucao).toMatchObject({ sourceType: 'VACCINATION', sourceId: criada.json().id })
  })

  it('no Starter o lote é ignorado e o estoque não é tocado', async () => {
    const lotId = await vacinaNoEstoque()
    await ownerPrisma.tenant.update({
      where: { id: fixture.tenantId },
      data: { plan: 'STARTER' },
    })

    const resposta = await registrar({ lotId })

    expect(resposta.statusCode, resposta.body).toBe(201)
    expect(resposta.json()).toMatchObject({ batch: 'DIGITADO' })
    expect(await saldo(lotId)).toBe('10')
  })
})
