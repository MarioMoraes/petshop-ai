import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  callApi,
  closeHarness,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
} from './harness.js'

/**
 * A fila de pedidos de exclusão de dados (LGPD art. 18, V — AC-05 de MOD-PORTAL-09).
 *
 * A garantia que esta suíte existe para segurar é uma só, e é fácil de perder de vista:
 * **responder o pedido não apaga a ficha.** A anonimização continua sendo o
 * `POST /v1/tutors/:id/anonymize`, com as travas de débito aberto e agenda futura. Se
 * alguém um dia "simplificar" ligando as duas coisas, um clique na fila passará a apagar
 * o cadastro de quem deve dinheiro ao petshop — e nenhum outro teste do repositório
 * perceberia.
 */

let tenant: TenantFixture

const maria = {
  fullName: 'Maria Silva',
  phone: '(11) 98765-4321',
  consents: { whatsapp: true, email: false, terms: true },
}

beforeEach(async () => {
  await resetDatabase()
  tenant = await givenTenant()
})

afterAll(closeHarness)

async function criarTutor(payload: Record<string, unknown> = maria): Promise<string> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/tutors',
    payload,
  })
  return response.json().id as string
}

function pedirExclusao(tutorId: string, reason?: string) {
  return callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/tutors/${tutorId}/deletion-request`,
    payload: reason ? { reason } : {},
  })
}

describe('registrar o pedido', () => {
  it('grava com o prazo de 15 dias e a prova de quem pediu', async () => {
    const tutorId = await criarTutor()

    const response = await pedirExclusao(tutorId, 'Não quero mais ser cliente')

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('OPEN')
    expect(body.tutorName).toBe('Maria Silva')
    expect(body.reason).toBe('Não quero mais ser cliente')

    const row = await ownerPrisma.dataDeletionRequest.findFirstOrThrow({
      where: { tutorId },
    })
    // Congelado na criação: o que foi prometido ao titular naquele dia foi aquilo, e
    // continua valendo mesmo que a regra mude depois.
    const dias = (row.dueAt.getTime() - row.createdAt.getTime()) / 86_400_000
    expect(Math.round(dias)).toBe(15)
  })

  it('a justificativa é opcional — a lei não a exige', async () => {
    const tutorId = await criarTutor()

    const response = await pedirExclusao(tutorId)

    expect(response.statusCode).toBe(201)
    expect(response.json().reason).toBeNull()
  })

  it('recusa o segundo pedido enquanto o primeiro está em análise', async () => {
    const tutorId = await criarTutor()
    await pedirExclusao(tutorId)

    const segunda = await pedirExclusao(tutorId)

    expect(segunda.statusCode).toBe(409)
    expect(segunda.json().code).toBe('ERR_TUTOR_010')
    expect(await ownerPrisma.dataDeletionRequest.count({ where: { tutorId } })).toBe(1)
  })

  it('depois de respondido, um pedido novo é aceito', async () => {
    const tutorId = await criarTutor()
    const primeiro = await pedirExclusao(tutorId)
    await resolver(primeiro.json().id, 'REJECTED', 'Há débito em aberto na sua conta.')

    const segunda = await pedirExclusao(tutorId)

    // A lei não dá direito de uma vez só, e a situação da ficha muda: a recusa de hoje
    // é "você tem débito", e daqui a um mês pode não ser mais.
    expect(segunda.statusCode).toBe(201)
  })
})

function resolver(requestId: string, outcome: 'DONE' | 'REJECTED', resolution: string) {
  return callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: `/v1/tutors/deletion-requests/${requestId}/resolve`,
    payload: { outcome, resolution },
  })
}

describe('a fila da equipe', () => {
  it('lista os abertos primeiro, com o nome e o saldo de cada ficha', async () => {
    const comDivida = await criarTutor({
      ...maria,
      fullName: 'Maria Silva',
      phone: '(11) 98765-4321',
    })
    const outro = await criarTutor({
      ...maria,
      fullName: 'João Souza',
      phone: '(11) 91111-2222',
    })
    await ownerPrisma.tutor.update({
      where: { id: comDivida },
      data: { balanceCents: -12_500 },
    })

    const respondido = await pedirExclusao(outro)
    await resolver(respondido.json().id, 'DONE', 'Cadastro anonimizado.')
    await pedirExclusao(comDivida)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors/deletion-requests',
    })

    expect(response.statusCode).toBe(200)
    const items = response.json().items
    expect(items).toHaveLength(2)
    // O aberto na frente: é o que a equipe precisa ver, e o respondido não disputa espaço.
    expect(items[0].status).toBe('OPEN')
    expect(items[0].tutorName).toBe('Maria Silva')
    /**
     * O saldo desce na linha porque é o dado que muda a resposta: ficha com débito aberto
     * não pode ser anonimizada, e quem decide precisa ver isso antes de prometer.
     */
    expect(items[0].balanceCents).toBe(-12_500)
  })

  it('o contador do sino conta só o que espera decisão', async () => {
    const um = await criarTutor({ ...maria, phone: '(11) 91111-1111' })
    const dois = await criarTutor({ ...maria, fullName: 'João', phone: '(11) 92222-2222' })
    const respondido = await pedirExclusao(um)
    await resolver(respondido.json().id, 'REJECTED', 'Débito em aberto.')
    await pedirExclusao(dois)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'GET',
      url: '/v1/tutors/deletion-requests/count',
    })

    expect(response.json().total).toBe(1)
  })

  it('a recepção não vê a fila: o gate é o mesmo da anonimização', async () => {
    const tutorId = await criarTutor()
    await pedirExclusao(tutorId)

    const response = await callApi({
      clerkUserId: tenant.clerkUserId,
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      role: 'RECEPTIONIST',
      // `tutor:read` e `tutor:update` bastam para o balcão registrar o pedido; a decisão
      // de apagar cadastro é de quem tem `tutor:delete`.
      permissions: ['tutor:read', 'tutor:update'],
      method: 'GET',
      url: '/v1/tutors/deletion-requests',
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('responder o pedido', () => {
  it('registra o desfecho e a frase que o titular vai ler', async () => {
    const tutorId = await criarTutor()
    const pedido = await pedirExclusao(tutorId)

    const response = await resolver(
      pedido.json().id,
      'REJECTED',
      'Há uma fatura em aberto. Procure a loja para regularizar.',
    )

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('REJECTED')
    expect(body.respondedAt).not.toBeNull()
    expect(body.resolution).toContain('fatura em aberto')
  })

  it('marcar como atendido NÃO apaga nem anonimiza a ficha', async () => {
    const tutorId = await criarTutor()
    const pedido = await pedirExclusao(tutorId)

    await resolver(pedido.json().id, 'DONE', 'Dados anonimizados conforme solicitado.')

    /**
     * A garantia central do módulo.
     *
     * A anonimização é operação própria, com as travas dela. Se um dia alguém ligar as
     * duas coisas, um clique na fila passará a apagar a ficha de quem tem débito aberto e
     * nota fiscal com prazo de guarda — e este é o único teste que perceberia.
     */
    const row = await ownerPrisma.tutor.findFirstOrThrow({ where: { id: tutorId } })
    expect(row.anonymizedAt).toBeNull()
    expect(row.deletedAt).toBeNull()
    expect(row.fullName).toBe('Maria Silva')
  })

  it('o segundo a responder recebe 409, e não sobrescreve o primeiro', async () => {
    const tutorId = await criarTutor()
    const pedido = await pedirExclusao(tutorId)
    await resolver(pedido.json().id, 'DONE', 'Resolvido pela Ana.')

    const segunda = await resolver(pedido.json().id, 'REJECTED', 'Resolvido pelo Carlos.')

    expect(segunda.statusCode).toBe(409)
    const row = await ownerPrisma.dataDeletionRequest.findFirstOrThrow({
      where: { id: pedido.json().id },
    })
    expect(row.resolution).toBe('Resolvido pela Ana.')
  })

  it('exige a frase de retorno nos dois desfechos', async () => {
    const tutorId = await criarTutor()
    const pedido = await pedirExclusao(tutorId)

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'POST',
      url: `/v1/tutors/deletion-requests/${pedido.json().id}/resolve`,
      payload: { outcome: 'DONE' },
    })

    // Um "concluído" sem palavra nenhuma deixa o titular sem saber o que sobrou da ficha
    // dele, e o dever de informar não distingue entre atender e negar.
    expect(response.statusCode).toBe(422)
  })
})
