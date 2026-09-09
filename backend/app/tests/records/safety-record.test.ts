import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenPet,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  asRoleIn,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-PRONT-03/04/05 — alergias, temperamento e alertas médicos, pelos critérios de
 * aceite do PRD prontuario_04 §3.
 *
 * O eixo dos testes é o que o módulo existe para garantir: **informação de segurança
 * não desaparece**. Alergia desativada continua no histórico, temperamento antigo
 * continua visível, e o alerta agregado sempre traz o mais grave primeiro.
 */

let tenant: TenantFixture
let petId: string

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
  petId = await givenPet(tenant)
})

afterAll(closeHarness)

function post(path: string, payload: unknown, caller?: Caller) {
  return callApi({
    ...(caller ?? asAdmin(tenant)),
    method: 'POST',
    url: `/v1/pets/${petId}${path}`,
    payload,
  })
}

function get(path: string, caller?: Caller) {
  return callApi({ ...(caller ?? asAdmin(tenant)), method: 'GET', url: `/v1/pets/${petId}${path}` })
}

describe('MOD-PRONT-03 — alergias e restrições', () => {
  it('AC-01: cria a alergia e ela passa a valer como alerta do pet', async () => {
    const response = await post('/allergies', {
      type: 'PRODUCT',
      label: 'Shampoo neutro marca X',
      severity: 'HIGH',
      reaction: 'Dermatite severa',
      blocksProducts: ['shampoo neutro x'],
      diagnosedAt: '2026-05-10',
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      label: 'Shampoo neutro marca X',
      severity: 'HIGH',
      active: true,
      reaction: 'Dermatite severa',
    })

    const alerts = await get('/alerts')
    expect(alerts.json()).toContainEqual({
      type: 'ALLERGY',
      severity: 'HIGH',
      label: 'Shampoo neutro marca X',
    })

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { entityId: petId, action: 'allergy.created' },
    })
    expect(audit).not.toBeNull()
    // §9: a trilha registra *que* a alergia existe, nunca o detalhe clínico.
    expect(JSON.stringify(audit?.after)).not.toContain('Dermatite')
  })

  it('AC-01: a reação fica cifrada em repouso', async () => {
    await post('/allergies', {
      type: 'FOOD',
      label: 'Frango',
      severity: 'MEDIUM',
      reaction: 'Coceira intensa e vômito',
    })

    const row = await ownerPrisma.allergy.findFirstOrThrow({ where: { petId } })
    expect(row.reactionEncrypted).not.toBeNull()
    expect(row.reactionEncrypted).not.toContain('Coceira')
  })

  it('AC-02: alergia CRÍTICA bloqueia o serviço e diz qual é a substância', async () => {
    const serviceId = '3f9a1c2e-0000-4000-8000-000000000001'
    await post('/allergies', {
      type: 'PRODUCT',
      label: 'Shampoo X',
      severity: 'CRITICAL',
      blocksServices: [serviceId],
    })

    const check = await post('/allergy-check', { serviceIds: [serviceId] })

    expect(check.statusCode).toBe(200)
    expect(check.json().blocked).toBe(true)
    expect(check.json().blocking[0].label).toBe('Shampoo X')
    expect(check.json().warnings).toHaveLength(0)
  })

  it('AC-03: severidade média avisa, mas não bloqueia', async () => {
    const serviceId = '3f9a1c2e-0000-4000-8000-000000000002'
    await post('/allergies', {
      type: 'PRODUCT',
      label: 'Condicionador Y',
      severity: 'MEDIUM',
      blocksServices: [serviceId],
    })

    const check = await post('/allergy-check', { serviceIds: [serviceId] })

    expect(check.json().blocked).toBe(false)
    expect(check.json().warnings[0].label).toBe('Condicionador Y')
  })

  it('AC-03: serviço sem relação com a alergia passa limpo', async () => {
    await post('/allergies', {
      type: 'PRODUCT',
      label: 'Shampoo X',
      severity: 'CRITICAL',
      blocksServices: ['3f9a1c2e-0000-4000-8000-000000000003'],
    })

    const check = await post('/allergy-check', {
      serviceIds: ['3f9a1c2e-0000-4000-8000-000000000009'],
    })

    expect(check.json()).toMatchObject({ blocked: false, blocking: [], warnings: [] })
  })

  it('AC-04: desativar exige justificativa e preserva o histórico', async () => {
    const created = await post('/allergies', {
      type: 'FOOD',
      label: 'Frango',
      severity: 'HIGH',
    })
    const allergyId = created.json().id as string

    const semJustificativa = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/allergies/${allergyId}`,
      payload: { active: false },
    })
    expect(semJustificativa.statusCode).toBe(422)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/allergies/${allergyId}`,
      payload: { active: false, resolutionNotes: 'Reavaliação clínica descartou a alergia' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ active: false })
    expect(response.json().deactivatedAt).not.toBeNull()

    // Sai dos alertas ativos…
    expect((await get('/alerts')).json()).toHaveLength(0)

    // …e permanece no histórico, com quem desativou.
    const record = await get('/safety-record')
    expect(record.json().allergies).toHaveLength(1)
    expect(record.json().allergies[0].resolutionNotes).toContain('Reavaliação')

    const row = await ownerPrisma.allergy.findUniqueOrThrow({ where: { id: allergyId } })
    expect(row.deactivatedBy).toBe(tenant.userId)
  })

  it('a alergia desativada deixa de bloquear o serviço', async () => {
    const serviceId = '3f9a1c2e-0000-4000-8000-000000000004'
    const created = await post('/allergies', {
      type: 'PRODUCT',
      label: 'Shampoo X',
      severity: 'CRITICAL',
      blocksServices: [serviceId],
    })

    await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/allergies/${created.json().id}`,
      payload: { active: false, resolutionNotes: 'Teste alérgico deu negativo' },
    })

    expect((await post('/allergy-check', { serviceIds: [serviceId] })).json().blocked).toBe(false)
  })

  it('a recepção registra alergia, mas não a desativa', async () => {
    // A matriz concede à recepção exatamente estas três: ler alerta, registrar alerta
    // e escrever nota. Desativar já é `record:write`, que ela não tem.
    const receptionist = await asRoleIn(tenant, 'RECEPTIONIST')

    const created = await post(
      '/allergies',
      { type: 'FOOD', label: 'Frango', severity: 'MEDIUM' },
      receptionist,
    )
    expect(created.statusCode).toBe(201)

    const desativa = await callApi({
      ...receptionist,
      method: 'PATCH',
      url: `/v1/pets/${petId}/allergies/${created.json().id}`,
      payload: { active: false, resolutionNotes: 'O tutor disse que era engano' },
    })
    expect(desativa.statusCode).toBe(403)
  })
})

describe('MOD-PRONT-04 — temperamento', () => {
  it('AC-01: registra a observação e o alerta carrega o manejo', async () => {
    const response = await post('/temperament', {
      classification: 'REACTIVE',
      contexts: ['NAIL_TRIMMING', 'DRYER'],
      notes: 'Precisa de focinheira para corte de unhas',
      requiresMuzzle: true,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ classification: 'REACTIVE', isCurrent: true })

    const alerts = await get('/alerts')
    expect(alerts.json()).toContainEqual({
      type: 'TEMPERAMENT',
      severity: 'HIGH',
      label: 'Reativo · exige focinheira',
    })
  })

  it('AC-02: classificação de risco sem contexto é recusada', async () => {
    const response = await post('/temperament', { classification: 'AGGRESSIVE' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PRONT_002')
    expect(JSON.stringify(response.json())).toContain('contexto')
  })

  it('AC-03/RN-15: o novo registro rebaixa o anterior, e só um fica vigente', async () => {
    await post('/temperament', {
      classification: 'AGGRESSIVE',
      notes: 'Mordeu o tosador em 2024',
    })
    await post('/temperament', { classification: 'DOCILE' })

    const history = await get('/temperament')
    expect(history.json().current.classification).toBe('DOCILE')
    expect(history.json().history).toHaveLength(2)

    // RN-16: dócil hoje não apaga o histórico de risco.
    expect(history.json().hadRiskHistory).toBe(true)

    const current = await ownerPrisma.temperament.count({ where: { petId, isCurrent: true } })
    expect(current).toBe(1)
  })

  it('AC-03: o pet dócil hoje não carrega alerta de temperamento', async () => {
    await post('/temperament', { classification: 'AGGRESSIVE', notes: 'Mordeu em 2024' })
    await post('/temperament', { classification: 'DOCILE' })

    const alerts = (await get('/alerts')).json() as { type: string }[]
    expect(alerts.filter((alert) => alert.type === 'TEMPERAMENT')).toHaveLength(0)
  })

  it('o banhista registra temperamento — é ele quem segura o pet', async () => {
    const response = await post(
      '/temperament',
      { classification: 'ANXIOUS', contexts: ['DRYER'] },
      await asRoleIn(tenant, 'BATHER'),
    )

    expect(response.statusCode).toBe(201)
  })

  it('a nota do temperamento fica cifrada em repouso', async () => {
    await post('/temperament', {
      classification: 'AGGRESSIVE',
      notes: 'Mordeu o tosador durante a secagem',
    })

    const row = await ownerPrisma.temperament.findFirstOrThrow({ where: { petId } })
    expect(row.notesEncrypted).not.toContain('Mordeu')
  })
})

describe('MOD-PRONT-05 — alertas médicos', () => {
  it('registra a condição com a instrução de execução', async () => {
    const response = await post('/medical-alerts', {
      condition: 'Cardiopatia',
      severity: 'CRITICAL',
      instructions: 'Não usar secador quente',
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ condition: 'Cardiopatia', active: true })

    const alerts = await get('/alerts')
    expect(alerts.json()).toContainEqual({
      type: 'MEDICAL',
      severity: 'CRITICAL',
      label: 'Cardiopatia',
    })
  })

  it('desativar exige justificativa e mantém a linha', async () => {
    const created = await post('/medical-alerts', { condition: 'Epilepsia', severity: 'HIGH' })

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/medical-alerts/${created.json().id}`,
      payload: { active: false, resolutionNotes: 'Condição controlada, alta veterinária' },
    })

    expect(response.statusCode).toBe(200)
    expect((await get('/alerts')).json()).toHaveLength(0)
    expect((await get('/safety-record')).json().medicalAlerts).toHaveLength(1)
  })

  it('a recepção não altera alerta médico', async () => {
    const created = await post('/medical-alerts', { condition: 'Diabetes', severity: 'HIGH' })

    const response = await callApi({
      ...(await asRoleIn(tenant, 'RECEPTIONIST')),
      method: 'PATCH',
      url: `/v1/pets/${petId}/medical-alerts/${created.json().id}`,
      payload: { severity: 'LOW' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('agregação de alertas', () => {
  it('ordena do mais grave para o menos grave', async () => {
    await post('/allergies', { type: 'FOOD', label: 'Frango', severity: 'LOW' })
    await post('/medical-alerts', { condition: 'Cardiopatia', severity: 'CRITICAL' })
    await post('/temperament', { classification: 'REACTIVE', notes: 'Reage ao secador' })

    const alerts = (await get('/alerts')).json() as { severity: string; label: string }[]

    expect(alerts.map((alert) => alert.severity)).toEqual(['CRITICAL', 'HIGH', 'LOW'])
  })

  it('o motorista vê os alertas — ele abre a caixa de transporte', async () => {
    await post('/temperament', { classification: 'AGGRESSIVE', notes: 'Morde quem se aproxima' })

    const response = await get('/alerts', await asRoleIn(tenant, 'DRIVER'))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveLength(1)
  })

  it('não vaza prontuário de pet de outro tenant', async () => {
    await post('/allergies', { type: 'FOOD', label: 'Frango', severity: 'HIGH' })

    const outsider = await givenTenant('Outro Petshop')
    const response = await get('/safety-record', asAdmin(outsider))

    expect(response.statusCode).toBe(404)
  })
})
