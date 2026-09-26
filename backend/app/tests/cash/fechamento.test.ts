import type { CashSessionDetail } from '@petshop/shared-types'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderClosingHtml } from '../../src/modules/cash/closing-template.js'
import { PdfUnavailableError, setPdfPort } from '../../src/modules/cash/pdf-port.js'
import { cashAlerts } from '../../src/modules/cash/sessions.js'
import {
  asAdmin,
  asRole,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * O caixa esquecido aberto (o sino) e o fechamento impresso.
 *
 * Esquecido é **aberto num dia que já passou, no fuso do petshop** — e é o fuso que
 * os testes de relógio fixo conferem: 22h de ontem em São Paulo já é hoje em UTC.
 */

let fixture: TenantFixture
let admin: Caller

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  admin = asAdmin(fixture)
})

afterEach(() => setPdfPort(null))

afterAll(closeHarness)

async function abrir(openingFloatCents = 10_000): Promise<string> {
  const resposta = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/cash/sessions',
    payload: { openingFloatCents },
  })
  expect(resposta.statusCode, resposta.body).toBe(201)
  return resposta.json().id as string
}

async function abertoEm(id: string, openedAt: Date): Promise<void> {
  await ownerPrisma.cashSession.update({ where: { id }, data: { openedAt } })
}

async function alertas() {
  const resposta = await callApi({ ...admin, method: 'GET', url: '/v1/cash/alerts' })
  expect(resposta.statusCode, resposta.body).toBe(200)
  return resposta.json() as { staleSession: { id: string; openedOn: string } | null }
}

describe('o caixa esquecido aberto', () => {
  it('sem caixa aberto, não há alerta', async () => {
    expect((await alertas()).staleSession).toBeNull()
  })

  it('o caixa aberto hoje não é esquecido', async () => {
    await abrir()
    expect((await alertas()).staleSession).toBeNull()
  })

  it('o caixa aberto ontem é, com o dia da abertura', async () => {
    const id = await abrir()
    await abertoEm(id, new Date(Date.now() - 26 * 60 * 60 * 1000))

    const { staleSession } = await alertas()

    expect(staleSession?.id).toBe(id)
    expect(staleSession?.openedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('o fechado não acende, por mais antigo que seja', async () => {
    const id = await abrir(0)
    await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/cash/sessions/${id}/close`,
      payload: { counts: [{ method: 'CASH', countedCents: 0 }] },
    })
    await abertoEm(id, new Date('2026-01-10T12:00:00Z'))

    expect((await alertas()).staleSession).toBeNull()
  })

  it('o dia é o do petshop, e não o de UTC', async () => {
    const id = await abrir()
    // 22h de 25/09 em São Paulo — 01h de 26/09 em UTC.
    await abertoEm(id, new Date('2026-09-26T01:00:00Z'))
    const actor = { tenantId: fixture.tenantId }

    // 23h do mesmo dia em São Paulo: a venda tardia não é esquecimento.
    const mesmaNoite = await cashAlerts(actor, new Date('2026-09-26T02:00:00Z'))
    expect(mesmaNoite.staleSession).toBeNull()

    // 8h do dia seguinte: agora é.
    const manha = await cashAlerts(actor, new Date('2026-09-26T11:00:00Z'))
    expect(manha.staleSession).toMatchObject({ id, openedOn: '2026-09-25' })
  })

  it('quem não lê o caixa não pergunta', async () => {
    const banhista = await asRole(fixture, 'BATHER')
    const resposta = await callApi({ ...banhista, method: 'GET', url: '/v1/cash/alerts' })
    expect(resposta.statusCode).toBe(403)
  })
})

describe('o fechamento em PDF', () => {
  it('devolve o PDF como anexo, com o dia no nome', async () => {
    const id = await abrir()
    setPdfPort({
      async render() {
        return Buffer.from('%PDF-1.4 dublê')
      },
    })

    const resposta = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/cash/sessions/${id}/pdf`,
    })

    expect(resposta.statusCode).toBe(200)
    expect(resposta.headers['content-type']).toBe('application/pdf')
    expect(resposta.headers['content-disposition']).toMatch(
      /^attachment; filename="fechamento-do-caixa-\d{4}-\d{2}-\d{2}\.pdf"$/,
    )
    expect(resposta.headers['cache-control']).toBe('no-store')
  })

  it('vira 503 quando o Gotenberg não responde', async () => {
    const id = await abrir()
    setPdfPort({
      async render() {
        throw new PdfUnavailableError('Gotenberg fora do ar')
      },
    })

    const resposta = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/cash/sessions/${id}/pdf`,
    })

    expect(resposta.statusCode).toBe(503)
    expect(resposta.json().code).toBe('ERR_DOC_005')
  })

  it('caixa de outro estabelecimento é 404', async () => {
    const outro = await givenTenant()
    const resposta = await callApi({
      ...asAdmin(outro),
      method: 'GET',
      url: `/v1/cash/sessions/${await abrir()}/pdf`,
    })
    expect(resposta.statusCode).toBe(404)
  })
})

describe('o HTML do fechamento', () => {
  const sessao: CashSessionDetail = {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'CLOSED',
    openedAt: '2026-09-25T11:00:00.000Z',
    openedByName: 'Ana <b>',
    openingFloatCents: 10_000,
    closedAt: '2026-09-25T23:30:00.000Z',
    closedByName: 'Bruno',
    byMethod: [
      { method: 'CASH', expectedCents: 15_000, countedCents: 13_000 },
      { method: 'PIX_MANUAL', expectedCents: 4_000, countedCents: null },
    ],
    receivedCents: 9_000,
    differenceCents: -2_000,
    closingNotes: 'Troco errado <script>alert(1)</script>',
    movements: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: 'WITHDRAWAL',
        method: 'CASH',
        amountCents: -4_000,
        description: 'Sangria · Cofre',
        createdByName: 'Bruno',
        occurredAt: '2026-09-25T20:00:00.000Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'OPENING_FLOAT',
        method: 'CASH',
        amountCents: 10_000,
        description: 'Troco Inicial',
        createdByName: 'Ana',
        occurredAt: '2026-09-25T11:00:00.000Z',
      },
    ],
  }

  const html = renderClosingHtml({
    session: sessao,
    tenantName: 'Pet & Cia',
    timeZone: 'America/Sao_Paulo',
    generatedAt: new Date('2026-09-26T12:00:00Z'),
  })

  it('escapa o que foi digitado', () => {
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Ana &lt;b&gt;')
    expect(html).toContain('Pet &amp; Cia')
  })

  it('diz a falta em palavras, e a forma não conferida fica fora', () => {
    expect(html).toMatch(/Faltam R\$\s20,00/)
    expect(html).toContain('não conferido')
  })

  it('os movimentos vêm na ordem em que aconteceram', () => {
    expect(html.indexOf('Troco Inicial</td>')).toBeLessThan(html.indexOf('Sangria · Cofre'))
  })

  it('a hora é a do petshop', () => {
    // 11h UTC é 8h em São Paulo.
    expect(html).toContain('08:00')
    expect(html).toContain('Fechamento do Caixa')
  })

  it('o caixa aberto imprime como parcial', () => {
    const parcial = renderClosingHtml({
      session: { ...sessao, status: 'OPEN', closedAt: null, differenceCents: null },
      tenantName: 'Pet',
      timeZone: 'America/Sao_Paulo',
      generatedAt: new Date(),
    })
    expect(parcial).toContain('Conferência Parcial')
    expect(parcial).not.toContain('Fechado em')
  })
})
