import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './fixtures.js'
import { handleMensagemRecebida } from '../../src/modules/tutors/consumers.js'

/** MOD-TUTOR-04 — consentimento LGPD, append-only. */

let tenant: TenantFixture
let tutorId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()

  const created = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/tutors',
    payload: {
      fullName: 'Maria Silva',
      phone: '11987654321',
      consents: { whatsapp: true, email: true, terms: true },
    },
  })
  tutorId = created.json().id
})

afterAll(closeHarness)

function putConsents(transitions: unknown[]) {
  return callApi({
    ...asAdmin(tenant),
    method: 'PUT',
    url: `/v1/tutors/${tutorId}/consents`,
    payload: { transitions },
  })
}

describe('MOD-TUTOR-04 — consentimento', () => {
  it('AC-01: o cadastro grava um registro por canal, com prova de origem', async () => {
    const rows = await ownerPrisma.tutorConsent.findMany({ where: { tutorId } })

    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.version).toBe('1.0')
      expect(row.source).toBe('STAFF_FORM')
      expect(row.createdAt).toBeInstanceOf(Date)
    }
  })

  it('AC-03: revogar e reautorizar preserva as três transições', async () => {
    await putConsents([{ channel: 'WHATSAPP', granted: false }])
    await putConsents([{ channel: 'WHATSAPP', granted: true }])

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/consents`,
    })

    const body = response.json()
    const whatsapp = body.history.filter(
      (record: { channel: string }) => record.channel === 'WHATSAPP',
    )
    expect(whatsapp).toHaveLength(3)
    expect(whatsapp.map((r: { granted: boolean }) => r.granted)).toEqual([true, false, true])

    // O estado atual é a última transição, derivada — não um campo sobrescrito.
    const current = body.current.find((s: { channel: string }) => s.channel === 'WHATSAPP')
    expect(current).toMatchObject({ granted: true, state: 'GRANTED' })
  })

  it('RN-05: o banco recusa UPDATE e DELETE na tabela de consentimento', async () => {
    await expect(
      ownerPrisma.$executeRaw`UPDATE "tutor_consents" SET "granted" = false WHERE "tutor_id" = ${tutorId}::uuid`,
    ).rejects.toThrow(/append-only/)

    await expect(
      ownerPrisma.$executeRaw`DELETE FROM "tutor_consents" WHERE "tutor_id" = ${tutorId}::uuid`,
    ).rejects.toThrow(/append-only/)
  })

  it('AC-04: aceite de termos em versão antiga vira PENDING_RENEWAL', async () => {
    /**
     * A versão antiga não se escreve mais à mão: desde o MOD-DOC-06 toda linha é
     * conferida contra `term_versions`, e o que envelhece um aceite é o tenant
     * **publicar** o texto seguinte.
     */
    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/terms',
      payload: {
        kind: 'TERMS',
        version: '2.0',
        title: 'Termos de uso e privacidade',
        body: '## Objeto\n\nRedação nova dos termos de uso, publicada pelo estabelecimento.',
      },
    })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/consents`,
    })

    const terms = response.json().current.find((s: { channel: string }) => s.channel === 'TERMS')
    expect(terms.state).toBe('PENDING_RENEWAL')
    expect(terms.granted).toBe(true)
  })

  it('registra a auditoria de cada transição', async () => {
    await putConsents([{ channel: 'EMAIL', granted: false }])

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { tenantId: tenant.tenantId, action: 'consent.revoked' },
    })
    expect(audit).not.toBeNull()
  })

  it('§8: "SAIR" no WhatsApp revoga o marketing, sem tocar no transacional', async () => {
    const revoked = await handleMensagemRecebida({
      tenantId: tenant.tenantId,
      tutorId,
      body: ' sair ',
    })
    expect(revoked).toBe(true)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/tutors/${tutorId}/consents`,
    })
    const whatsapp = response
      .json()
      .current.find((s: { channel: string }) => s.channel === 'WHATSAPP')
    expect(whatsapp).toMatchObject({ granted: false, state: 'REVOKED', purpose: 'MARKETING' })

    // O opt-in original continua no histórico: revogar não apaga a prova.
    const history = await ownerPrisma.tutorConsent.findMany({
      where: { tutorId, channel: 'WHATSAPP' },
      orderBy: { createdAt: 'asc' },
    })
    expect(history.map((r) => r.granted)).toEqual([true, false])
    expect(history[1]?.source).toBe('WHATSAPP')
  })

  it('mensagem comum não mexe em consentimento', async () => {
    const revoked = await handleMensagemRecebida({
      tenantId: tenant.tenantId,
      tutorId,
      body: 'oi, queria marcar um banho',
    })
    expect(revoked).toBe(false)
    expect(await ownerPrisma.tutorConsent.count({ where: { tutorId, channel: 'WHATSAPP' } })).toBe(1)
  })

  it('cadastro sem aceite dos termos é 422', async () => {
    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: '/v1/tutors',
      payload: {
        fullName: 'Sem Aceite',
        phone: '11955554444',
        consents: { whatsapp: false, email: false, terms: false },
      },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().errors[0].message).toBe('Aceite dos termos é obrigatório')
  })
})
