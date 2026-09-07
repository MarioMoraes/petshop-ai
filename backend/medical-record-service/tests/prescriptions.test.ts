import { withTenant } from '@petshop/db'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfUnavailableError, setPdfPort } from '../src/lib/pdf.js'
import { setStoragePort } from '../src/lib/storage.js'
import { retryPendingPrescriptions } from '../src/modules/prescriptions/service.js'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenIssuerSettings,
  givenPet,
  givenTenant,
  givenTutor,
  givenVet,
  linkTutor,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * Receituário veterinário (MOD-DOC-04) e o CRMV do profissional (MOD-DOC-05).
 *
 * O Gotenberg e o R2 são dublados: o que está sob teste é o **gate do CRMV**, a
 * imutabilidade, o snapshot e a degradação. Que o Gotenberg converta HTML é problema do
 * Gotenberg, e `packages/pdf` já cobre o protocolo.
 *
 * O que **não** é dublado é o miolo do documento: o HTML que sobe para o dublê é o
 * mesmo que iria para o Chromium, e é nele que se confere o escape e o alerta crítico.
 */

let tenant: TenantFixture
let petId: string
let tutorId: string
let attendanceId: string

interface FakePdf {
  calls: string[]
  failWith: Error | null
}

let pdf: FakePdf
let objetos: Map<string, Buffer>

function installFakes(): void {
  pdf = { calls: [], failWith: null }
  objetos = new Map()

  setPdfPort({
    async render(html) {
      if (pdf.failWith) throw pdf.failWith
      pdf.calls.push(html)
      return Buffer.from('%PDF-1.4 dublê')
    },
  })

  setStoragePort({
    async put(key, body) {
      objetos.set(key, body)
    },
    async signedUrl(key) {
      return `https://r2.test/${key}?assinada=1`
    },
  })
}

/**
 * O atendimento veterinário de onde nasce a prescrição.
 *
 * Criado direto no banco, e não pelo evento de check-out: o que importa aqui é que a
 * linha exista com o tipo certo, e o caminho de nascimento do atendimento já é coberto
 * por `attendances.test.ts`.
 */
async function givenVetAttendance(
  performedBy: string,
  type: 'VET_CONSULT' | 'BATH' = 'VET_CONSULT',
): Promise<string> {
  return withTenant(tenant.tenantId, async (tx) => {
    const attendance = await tx.attendance.create({
      data: {
        tenantId: tenant.tenantId,
        petId,
        tutorId,
        type,
        performedBy,
        startedAt: new Date(Date.now() - 3_600_000),
        finishedAt: new Date(),
        status: 'COMPLETED',
      },
      select: { id: true },
    })
    return attendance.id
  })
}

const RECEITA = {
  items: [
    {
      drug: 'Amoxicilina',
      concentration: '50 mg/mL',
      dosage: '1 mL',
      frequency: 'a cada 12 horas',
      durationDays: 7,
    },
  ],
  instructions: 'Dar com comida. Não interromper antes do fim.',
}

function emitir(payload: unknown = RECEITA, attendance = attendanceId) {
  return callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/attendances/${attendance}/prescriptions`,
    payload,
  })
}

beforeEach(async () => {
  await resetDatabase()
  installFakes()
  tenant = await givenTenant()
  await givenIssuerSettings(tenant)
  petId = await givenPet(tenant)
  tutorId = await givenTutor(tenant)
  await linkTutor(tenant, petId, tutorId)
})

afterEach(() => {
  setPdfPort(null)
  setStoragePort(null)
})

afterAll(closeHarness)

describe('MOD-DOC-04 — emissão do receituário', () => {
  it('AC-01: emite com número na série RX, arquiva o PDF e grava o CRMV em snapshot', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)

    const response = await emitir()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body).toMatchObject({
      number: `RX-${new Date().getUTCFullYear()}/000001`,
      crmv: '12345/SP',
      vetId,
      documentStatus: 'ISSUED',
    })
    expect(body.items).toHaveLength(1)
    expect(body.url).toContain('https://r2.test/')
    expect(objetos.size).toBe(1)

    // O documento é o dono do arquivo; a prescrição aponta para ele.
    const documento = await ownerPrisma.document.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(documento).toMatchObject({ kind: 'PRESCRIPTION', status: 'ISSUED', petId, tutorId })
    expect(documento.checksum).toHaveLength(64)
  })

  it('AC-01: os itens e as orientações ficam cifrados no banco', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    await emitir()

    const row = await ownerPrisma.prescription.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(row.itemsEncrypted).not.toContain('Amoxicilina')
    expect(row.itemsEncrypted.startsWith('v1:')).toBe(true)
    expect(row.instructionsEncrypted).not.toContain('comida')
  })

  it('AC-02: profissional sem CRMV recebe 403 ERR_PRONT_009', async () => {
    const vetId = await givenVet(tenant, { crmv: null, crmvState: null })
    attendanceId = await givenVetAttendance(vetId)

    const response = await emitir()

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PRONT_009')
    expect(await ownerPrisma.prescription.count()).toBe(0)
  })

  it('AC-02: usuário sem profissional vinculado não prescreve, mesmo sendo admin', async () => {
    // O vínculo é `professionals.user_id`, e ele é opcional: a agenda tem gente que
    // trabalha sem conta. Quem não tem conta ligada não assina documento.
    const vetId = await givenVet(tenant, { userId: undefined })
    await withTenant(tenant.tenantId, (tx) =>
      tx.professional.update({ where: { id: vetId }, data: { userId: null } }),
    )
    attendanceId = await givenVetAttendance(vetId)

    const response = await emitir()

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_PRONT_009')
  })

  it('AC-03: item sem posologia é 422 apontando o índice e o campo', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)

    const response = await emitir({
      items: [
        { drug: 'Amoxicilina', dosage: '1 mL', frequency: 'a cada 12h', durationDays: 7 },
        { drug: 'Dipirona', dosage: '', frequency: 'a cada 8h', durationDays: 3 },
      ],
    })

    expect(response.statusCode).toBe(422)
    const problem = response.json()
    expect(problem.code).toBe('ERR_PRONT_002')
    expect(problem.errors.some((error: { field: string }) => error.field.includes('1'))).toBe(true)
    expect(await ownerPrisma.prescription.count()).toBe(0)
  })

  it('AC-03: duração menor que 1 dia não passa', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)

    const response = await emitir({
      items: [{ drug: 'Dipirona', dosage: '1 mL', frequency: 'diária', durationDays: 0 }],
    })

    expect(response.statusCode).toBe(422)
  })

  it('receituário não sai de banho: o tipo do atendimento é gate', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId, 'BATH')

    const response = await emitir()

    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toContain('veterinário')
  })

  it('AC-02 de MOD-DOC-01: sem endereço do estabelecimento, 422 dizendo o que falta', async () => {
    // O tenant nasce sem `tenant_settings` — é o parque anterior a 2026-08-28.
    const outro = await givenTenant('Petshop Sem Endereço')
    const outroPet = await givenPet(outro)
    const outroTutor = await givenTutor(outro)
    await linkTutor(outro, outroPet, outroTutor)
    const vetId = await givenVet(outro)

    const attendance = await withTenant(outro.tenantId, async (tx) => {
      const row = await tx.attendance.create({
        data: {
          tenantId: outro.tenantId,
          petId: outroPet,
          tutorId: outroTutor,
          type: 'VET_CONSULT',
          performedBy: vetId,
          startedAt: new Date(Date.now() - 3_600_000),
          finishedAt: new Date(),
          status: 'COMPLETED',
        },
        select: { id: true },
      })
      return row.id
    })

    const response = await callApi({
      ...asAdmin(outro),
      method: 'POST',
      url: `/v1/attendances/${attendance}/prescriptions`,
      payload: RECEITA,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_DOC_002')
    expect(response.json().detail).toContain('endereço')
  })

  it('atendimento anulado não recebe receituário', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    await withTenant(tenant.tenantId, (tx) =>
      tx.attendance.update({
        where: { id: attendanceId },
        data: { status: 'VOIDED', voidReason: 'lançamento errado', voidedAt: new Date() },
      }),
    )

    const response = await emitir()
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('ERR_PRONT_006')
  })
})

describe('MOD-DOC-04 — o que o papel mostra', () => {
  it('AC-05: alergia crítica do pet sai em destaque no documento', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/pets/${petId}/allergies`,
      payload: { type: 'MEDICATION', label: 'Penicilina', severity: 'CRITICAL' },
    })

    await emitir()

    const html = pdf.calls[0] ?? ''
    expect(html).toContain('alertas críticos')
    expect(html).toContain('Penicilina')
  })

  it('AC-03 de MOD-DOC-01: campo livre com HTML sai literal, não executa', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)

    await emitir({
      items: [
        {
          drug: '<script>alert(1)</script>',
          dosage: '<5 kg: meio comprimido',
          frequency: 'a cada 12h',
          durationDays: 3,
        },
      ],
    })

    const html = pdf.calls[0] ?? ''
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;5 kg')
  })

  it('o documento leva o nome e o registro de quem assinou', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    await emitir()

    const html = pdf.calls[0] ?? ''
    expect(html).toContain('Dra. Helena Prado')
    expect(html).toContain('CRMV 12345/SP')
    // O cabeçalho comum do MOD-DOC-01, vindo de `@petshop/documents`.
    expect(html).toContain('Avenida Paulista')
  })
})

describe('MOD-DOC-05 — o CRMV é snapshot', () => {
  it('AC-03: corrigir o registro não reescreve receituário já emitido', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const emitido = await emitir()
    const prescriptionId = emitido.json().id

    await withTenant(tenant.tenantId, (tx) =>
      tx.professional.update({ where: { id: vetId }, data: { crmv: '99999', crmvState: 'RJ' } }),
    )

    const detalhe = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/prescriptions/${prescriptionId}`,
    })

    expect(detalhe.json().crmv).toBe('12345/SP')
  })
})

describe('MOD-DOC-04 — imutabilidade e anulação', () => {
  it('AC-04: não existe rota que edite o receituário emitido', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const prescriptionId = (await emitir()).json().id

    const patch = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/prescriptions/${prescriptionId}`,
      payload: { items: [] },
    })

    expect(patch.statusCode).toBe(404)
  })

  it('anular mantém o arquivo e o número, cancela o documento e exige motivo', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const emitida = (await emitir()).json()

    const semMotivo = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/prescriptions/${emitida.id}/void`,
      payload: { reason: '' },
    })
    expect(semMotivo.statusCode).toBe(422)

    const anulada = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/prescriptions/${emitida.id}/void`,
      payload: { reason: 'Dosagem digitada errada' },
    })

    expect(anulada.statusCode).toBe(200)
    expect(anulada.json()).toMatchObject({
      number: emitida.number,
      voidReason: 'Dosagem digitada errada',
    })

    const documento = await ownerPrisma.document.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(documento.status).toBe('CANCELLED')
    // RN-03: o arquivo continua no bucket. Cancelar muda o que o sistema diz sobre o
    // documento, não o papel que a pessoa levou.
    expect(documento.storageKey).not.toBeNull()
    expect(objetos.size).toBe(1)
  })

  it('anular duas vezes é 409', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const emitida = (await emitir()).json()

    const primeira = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/prescriptions/${emitida.id}/void`,
      payload: { reason: 'Dosagem digitada errada' },
    })
    expect(primeira.statusCode).toBe(200)

    const segunda = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/prescriptions/${emitida.id}/void`,
      payload: { reason: 'De novo' },
    })
    expect(segunda.statusCode).toBe(409)
    expect(segunda.json().code).toBe('ERR_PRONT_006')
  })

  it('RN-04: o número do anulado não volta para a série', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const primeira = (await emitir()).json()

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/prescriptions/${primeira.id}/void`,
      payload: { reason: 'Dosagem digitada errada' },
    })

    const segunda = (await emitir()).json()
    expect(segunda.number).not.toBe(primeira.number)
    expect(segunda.number.endsWith('000002')).toBe(true)
  })
})

describe('MOD-DOC-11 — degradação e reprocesso', () => {
  it('RN-07: Gotenberg fora do ar não derruba a emissão — a prescrição fica pendente', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    pdf.failWith = new PdfUnavailableError('gotenberg fora do ar')

    const response = await emitir()

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ documentStatus: 'PENDING', url: null })
    expect(await ownerPrisma.prescription.count()).toBe(1)

    const documento = await ownerPrisma.document.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(documento.attempts).toBe(1)
    expect(documento.lastError).toContain('gotenberg')
  })

  it('o job varre o que ficou pendente e emite quando o Gotenberg volta', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    pdf.failWith = new PdfUnavailableError('gotenberg fora do ar')
    await emitir()

    pdf.failWith = null
    const resultado = await retryPendingPrescriptions()

    expect(resultado.issued).toBe(1)
    const documento = await ownerPrisma.document.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(documento.status).toBe('ISSUED')
    expect(objetos.size).toBe(1)
  })

  it('o job não reemite receituário anulado', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    pdf.failWith = new PdfUnavailableError('gotenberg fora do ar')
    const pendente = (await emitir()).json()

    await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/prescriptions/${pendente.id}/void`,
      payload: { reason: 'Emitida por engano' },
    })

    pdf.failWith = null
    expect((await retryPendingPrescriptions()).issued).toBe(0)
    expect(objetos.size).toBe(0)
  })

  it('AC-05 de MOD-DOC-02: reemitir não sobrescreve o arquivo já entregue', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    await emitir()
    expect(pdf.calls).toHaveLength(1)

    // O job passa de novo; o documento já está `ISSUED` e nada é renderizado.
    await retryPendingPrescriptions()
    expect(pdf.calls).toHaveLength(1)
  })
})

describe('MOD-DOC-04 — leitura', () => {
  it('a lista do pet não assina URL; o detalhe assina', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const emitida = (await emitir()).json()

    const lista = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/pets/${petId}/prescriptions`,
    })
    expect(lista.statusCode).toBe(200)
    expect(lista.json().prescriptions).toHaveLength(1)
    expect(lista.json().prescriptions[0].url).toBeNull()

    const detalhe = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: `/v1/prescriptions/${emitida.id}`,
    })
    expect(detalhe.json().url).toContain('assinada=1')

    // §9: baixar documento arquivado entra na trilha, com quem pediu.
    const trilha = await ownerPrisma.auditLog.findMany({
      where: { tenantId: tenant.tenantId, action: 'document.downloaded' },
    })
    expect(trilha).toHaveLength(1)
  })

  it('a emissão entra na trilha como document.issued, com tipo e número', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const emitida = (await emitir()).json()

    const trilha = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, action: 'document.issued' },
    })
    // `documentNumber` e não `number`: `number` é chave sensível no `service-kit` — é
    // o número do endereço — e a trilha gravaria `[redacted]` no lugar da série.
    expect(trilha.after).toMatchObject({
      kind: 'PRESCRIPTION',
      documentNumber: emitida.number,
    })
  })

  it('receituário de outro tenant é 404, nunca 403', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    const emitida = (await emitir()).json()

    const outro = await givenTenant('Petshop Vizinho')
    const response = await callApi({
      ...asAdmin(outro),
      method: 'GET',
      url: `/v1/prescriptions/${emitida.id}`,
    })

    expect(response.statusCode).toBe(404)
  })

  it('quem só tem o recorte operacional não lê a posologia', async () => {
    const vetId = await givenVet(tenant)
    attendanceId = await givenVetAttendance(vetId)
    await emitir()

    const response = await callApi({
      clerkUserId: tenant.clerkUserId,
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      role: 'GROOMER',
      permissions: ['record:read_alerts', 'record:write_notes'],
      method: 'GET',
      url: `/v1/pets/${petId}/prescriptions`,
    })

    expect(response.statusCode).toBe(403)
  })
})
