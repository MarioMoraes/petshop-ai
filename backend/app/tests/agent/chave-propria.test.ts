import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asReceptionist,
  callApi,
  callWebhook,
  captureScheduledTurns,
  closeHarness,
  enableAgent,
  enableMessaging,
  givenTenant,
  givenTutor,
  givenWhatsapp,
  installFakeMessaging,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  upsertPayload,
  type TenantFixture,
} from './fixtures.js'

const { setKeyVerifier } = await import('../../src/modules/agent/api-key.js')
const { ModelKeyRejectedError, getModelPort, setModelPort } =
  await import('../../src/modules/agent/model-port.js')
const { answer } = await import('../../src/modules/agent/runner.js')

/**
 * A chave da Anthropic do estabelecimento (Configurações › Integrações).
 *
 * O verificador é dublado: a suíte não fala com a Anthropic. O que se prova é o que é
 * nosso — a recusa que não grava, a cifra, a trilha sem o valor, o corte de permissão e a
 * recusa no meio da conversa que vira aviso na tela.
 */

const CHAVE = 'sk-ant-api03-chave-de-teste-que-termina-em-WXYZ'

let tenant: TenantFixture
let aceita: boolean

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  aceita = true
  setKeyVerifier(async () => aceita)
  tenant = await givenTenant()
})

afterAll(async () => {
  setKeyVerifier(null)
  await closeHarness()
})

function cadastrar(apiKey = CHAVE) {
  return callApi({
    ...asAdmin(tenant),
    method: 'PUT',
    url: '/v1/agent/api-key',
    payload: { apiKey },
  })
}

describe('a chave própria da IA', () => {
  it('grava cifrada e devolve só os quatro últimos caracteres', async () => {
    const response = await cadastrar()

    expect(response.statusCode).toBe(200)
    expect(response.json().apiKey).toMatchObject({ last4: 'WXYZ', error: null })
    expect(JSON.stringify(response.json())).not.toContain(CHAVE)

    const linha = await ownerPrisma.agentSettings.findUniqueOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    expect(linha.apiKeyEncrypted).toBeTruthy()
    expect(linha.apiKeyEncrypted).not.toContain(CHAVE)
  })

  it('a trilha registra a troca sem o valor', async () => {
    await cadastrar()

    const trilha = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, action: 'agent.api_key_set' },
    })
    expect(JSON.stringify(trilha)).not.toContain(CHAVE)
    expect(trilha.after).toEqual({ last4: 'WXYZ' })
  })

  it('a chave que a Anthropic recusa não é gravada', async () => {
    aceita = false
    const response = await cadastrar()

    expect(response.statusCode).toBe(422)
    const linha = await ownerPrisma.agentSettings.findUnique({
      where: { tenantId: tenant.tenantId },
    })
    expect(linha?.apiKeyEncrypted ?? null).toBeNull()
  })

  it('o que não parece chave da Anthropic nem chega a ser conferido', async () => {
    let conferiu = false
    setKeyVerifier(async () => {
      conferiu = true
      return true
    })

    const response = await cadastrar('chave-de-outro-provedor-1234567890')

    expect(response.statusCode).toBe(422)
    expect(conferiu).toBe(false)
  })

  it('a recepção não cadastra nem remove a chave', async () => {
    const recepcao = await asReceptionist(tenant)

    const put = await callApi({
      ...recepcao,
      method: 'PUT',
      url: '/v1/agent/api-key',
      payload: { apiKey: CHAVE },
    })
    const del = await callApi({ ...recepcao, method: 'DELETE', url: '/v1/agent/api-key' })

    expect(put.statusCode).toBe(403)
    expect(del.statusCode).toBe(403)
  })

  it('remover apaga a chave e deixa trilha', async () => {
    await cadastrar()

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: '/v1/agent/api-key',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().apiKey).toBeNull()
    expect(
      await ownerPrisma.auditLog.count({
        where: { tenantId: tenant.tenantId, action: 'agent.api_key_removed' },
      }),
    ).toBe(1)
  })

  it('com a chave cadastrada, a porta do estabelecimento responde por ela', async () => {
    setModelPort(null)
    await cadastrar()

    const porta = await getModelPort(tenant.tenantId)
    expect(porta.configured).toBe(true)
    // Um cliente por chave: a segunda leitura acha o mesmo.
    expect(await getModelPort(tenant.tenantId)).toBe(porta)
  })
})

describe('a chave recusada no meio da conversa', () => {
  it('a conversa vai para a recepção e a tela passa a dizer por quê', async () => {
    installFakeMessaging()
    captureScheduledTurns()
    const token = await givenWhatsapp(tenant)
    await enableMessaging(tenant)
    await enableAgent(tenant)
    await givenTutor(tenant)
    await cadastrar()

    setModelPort({
      configured: true,
      async complete() {
        throw new ModelKeyRejectedError('A Anthropic recusou a chave (401)')
      },
    })

    await callWebhook(token, upsertPayload({ text: 'tem horário amanhã?' }))
    const conversa = await ownerPrisma.agentConversation.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    })
    await answer(tenant.tenantId, conversa.id)

    const depois = await ownerPrisma.agentConversation.findUniqueOrThrow({
      where: { id: conversa.id },
    })
    expect(depois.status).toBe('HANDOFF')

    const settings = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/agent/settings' })
    expect(settings.json().apiKey.error).toContain('401')

    // Cadastrar de novo é o que prova que a chave voltou a servir, e apaga o aviso.
    const recadastro = await cadastrar()
    expect(recadastro.json().apiKey.error).toBeNull()
  })
})
