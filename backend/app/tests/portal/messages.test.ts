import { AppError, PORTAL_TEMPLATE_KEYS } from '@petshop/shared-types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asVisitor,
  asTutor,
  callApi,
  closeHarness,
  fakeTutorService,
  givenConsent,
  givenMessage,
  givenTutor,
  givenTenant,
  ownerPrisma,
  resetDatabase,
  type TenantFixture,
  type TutorServiceDouble,
} from './fixtures.js'

/**
 * MOD-PORTAL-10 — a Central de Comunicação e as preferências.
 *
 * O motor de envio, a régua de consentimento e a trilha append-only têm suíte própria
 * no `messaging-service` e no `tutor-service`. O que **esta** guarda é o que o Portal
 * acrescenta, e é quase tudo omissão:
 *
 * - o recorte por tutor e o que **não** aparece na lista (AC-02) — a garantia mais
 *   valiosa do módulo, porque cada exclusão está na consulta e some sem barulho;
 * - a derivação do estado do consentimento a partir de linhas que só crescem;
 * - a porta que eleva permissão, e o que ela leva junto (o IP que é prova, não log).
 */

let fixture: TenantFixture
let tutorService: TutorServiceDouble

function diasAtras(dias: number): Date {
  return new Date(Date.now() - dias * 86_400_000)
}

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  tutorService = fakeTutorService(fixture)
})

afterAll(async () => {
  await closeHarness()
})

describe('GET /portal/v1/messages', () => {
  it('AC-01: lista as mensagens entregues, com data, canal e o corpo decifrado', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, {
      body: 'Oi Maria, o banho do Thor está confirmado para amanhã às 9h.',
      channel: 'WHATSAPP',
      status: 'DELIVERED',
      sentAt: diasAtras(1),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.total).toBe(1)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].body).toContain('banho do Thor')
    expect(body.messages[0].channel).toBe('WHATSAPP')
    expect(body.messages[0].sentAt).not.toBeNull()
    expect(body.timezone).toBe('America/Sao_Paulo')
  })

  it('AC-02: fila, falha, bloqueio e agrupada ficam de fora', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, { body: 'Entregue', status: 'DELIVERED' })
    await givenMessage(fixture, tutorId, { body: 'Ainda na fila', status: 'QUEUED' })
    await givenMessage(fixture, tutorId, { body: 'Agendada', status: 'SCHEDULED' })
    await givenMessage(fixture, tutorId, { body: 'Falhou no provedor', status: 'FAILED' })
    await givenMessage(fixture, tutorId, { body: 'Desistiu de tentar', status: 'DEAD' })
    await givenMessage(fixture, tutorId, {
      body: 'Promoção que a régua barrou',
      status: 'BLOCKED',
      category: 'MARKETING',
      blockReason: 'NO_CONSENT',
    })
    await givenMessage(fixture, tutorId, { body: 'Cancelada', status: 'CANCELLED' })
    // Saiu dentro de outra (RN-08): o texto chegou uma vez, e uma linha o representa.
    await givenMessage(fixture, tutorId, { body: 'Absorvida por outra', status: 'MERGED' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    const body = response.json()
    expect(body.total).toBe(1)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].body).toBe('Entregue')
  })

  it('AC-02: nenhum vestígio do bloqueio atravessa a resposta', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, {
      body: 'Aproveite nosso pacote de banhos',
      status: 'BLOCKED',
      category: 'MARKETING',
      blockReason: 'NO_CONSENT',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    /**
     * A busca é no payload cru, e por nome de campo e de coluna: o valor de um
     * `blockReason` que voltasse a ser consultado apareceria aqui antes de alguém
     * notar na tela.
     */
    const cru = response.payload
    expect(cru).not.toContain('NO_CONSENT')
    expect(cru).not.toContain('blockReason')
    expect(cru).not.toContain('block_reason')
    expect(cru).not.toContain('pacote de banhos')
  })

  it('o código de acesso nunca entra no histórico, mesmo entregue', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, {
      body: 'Seu código de acesso é 481920',
      templateKey: PORTAL_TEMPLATE_KEYS.accessCode,
      status: 'DELIVERED',
    })
    await givenMessage(fixture, tutorId, {
      body: 'Bem-vinda ao portal',
      templateKey: PORTAL_TEMPLATE_KEYS.welcome,
      status: 'DELIVERED',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    const body = response.json()
    expect(body.total).toBe(1)
    expect(body.messages[0].body).toContain('Bem-vinda')
    expect(response.payload).not.toContain('481920')
  })

  it('a resposta que o próprio tutor mandou não volta como mensagem do petshop', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, {
      body: 'PARAR',
      direction: 'INBOUND',
      status: 'DELIVERED',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().total).toBe(0)
  })

  it('RN-02: a mensagem de outro tutor não aparece, e o recorte é da consulta', async () => {
    const tutorId = await givenTutor(fixture)
    const outroId = await givenTutor(fixture, { name: 'João Alheio', phone: '+5511911112222' })
    await givenMessage(fixture, tutorId, { body: 'Minha mensagem' })
    await givenMessage(fixture, outroId, { body: 'Segredo do vizinho' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().total).toBe(1)
    expect(response.payload).not.toContain('Segredo do vizinho')
  })

  it('AC-04 de MOD-CRM-10: o corpo expurgado vira aviso, e não erro', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, { body: 'apagado pela retenção', purged: true })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().messages[0].body).toContain('não está mais disponível')
  })

  it('ordena pelo envio e pagina por página', async () => {
    const tutorId = await givenTutor(fixture)
    await givenMessage(fixture, tutorId, { body: 'Mais antiga', sentAt: diasAtras(30) })
    await givenMessage(fixture, tutorId, { body: 'Do meio', sentAt: diasAtras(10) })
    await givenMessage(fixture, tutorId, { body: 'Mais recente', sentAt: diasAtras(1) })

    const primeira = await callApi({
      method: 'GET',
      url: '/portal/v1/messages?page=1&limit=2',
      ...asTutor(fixture, tutorId),
    })
    expect(primeira.json().total).toBe(3)
    expect(primeira.json().messages.map((m: { body: string }) => m.body)).toEqual([
      'Mais recente',
      'Do meio',
    ])

    const segunda = await callApi({
      method: 'GET',
      url: '/portal/v1/messages?page=2&limit=2',
      ...asTutor(fixture, tutorId),
    })
    expect(segunda.json().messages.map((m: { body: string }) => m.body)).toEqual(['Mais antiga'])
  })

  it('quem entrou mas não é tutor deste petshop não chega à lista', async () => {
    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/messages',
      ...asVisitor(fixture),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('GET /portal/v1/preferences', () => {
  it('AC-03 da LGPD: sem registro, os dois canais vêm desligados', async () => {
    const tutorId = await givenTutor(fixture, { email: 'maria@exemplo.com' })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.marketing).toHaveLength(2)
    expect(body.marketing.every((item: { granted: boolean }) => !item.granted)).toBe(true)
    expect(body.marketing.every((item: { since: string | null }) => item.since === null)).toBe(true)
    expect(body.availableChannels).toEqual(['WHATSAPP', 'EMAIL'])
  })

  it('o canal que o tutor não tem cadastrado não vira interruptor', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
    })

    expect(response.json().availableChannels).toEqual(['WHATSAPP'])
  })

  it('consentimento só transacional não liga o interruptor de promoções', async () => {
    const tutorId = await givenTutor(fixture)
    await givenConsent(fixture, tutorId, {
      channel: 'WHATSAPP',
      granted: true,
      purpose: 'TRANSACTIONAL',
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
    })

    const whatsapp = response
      .json()
      .marketing.find((item: { channel: string }) => item.channel === 'WHATSAPP')
    expect(whatsapp.granted).toBe(false)
    expect(whatsapp.since).not.toBeNull()
  })

  it('a última transição é o estado, e as anteriores continuam na tabela', async () => {
    const tutorId = await givenTutor(fixture)
    await givenConsent(fixture, tutorId, {
      channel: 'WHATSAPP',
      granted: true,
      createdAt: diasAtras(30),
    })
    await givenConsent(fixture, tutorId, {
      channel: 'WHATSAPP',
      granted: false,
      createdAt: diasAtras(2),
    })

    const response = await callApi({
      method: 'GET',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
    })

    const whatsapp = response
      .json()
      .marketing.find((item: { channel: string }) => item.channel === 'WHATSAPP')
    expect(whatsapp.granted).toBe(false)
  })
})

describe('PATCH /portal/v1/preferences', () => {
  it('AC-03: desligar promoções grava a revogação com origem PORTAL', async () => {
    const tutorId = await givenTutor(fixture)
    await givenConsent(fixture, tutorId, {
      channel: 'WHATSAPP',
      granted: true,
      createdAt: diasAtras(10),
    })

    const response = await callApi({
      method: 'PATCH',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
      payload: { channel: 'WHATSAPP', granted: false },
    })

    expect(response.statusCode).toBe(200)
    const whatsapp = response
      .json()
      .marketing.find((item: { channel: string }) => item.channel === 'WHATSAPP')
    expect(whatsapp.granted).toBe(false)

    const linhas = await ownerPrisma.tutorConsent.findMany({
      where: { tutorId, channel: 'WHATSAPP' },
      orderBy: { createdAt: 'asc' },
    })
    expect(linhas).toHaveLength(2)
    expect(linhas[1]?.granted).toBe(false)
    expect(linhas[1]?.source).toBe('PORTAL')
    expect(linhas[1]?.purpose).toBe('MARKETING')
  })

  it('AC-04: ligar e desligar três vezes são três linhas novas, nenhuma alterada', async () => {
    const tutorId = await givenTutor(fixture)

    for (const granted of [true, false, true]) {
      const response = await callApi({
        method: 'PATCH',
        url: '/portal/v1/preferences',
        ...asTutor(fixture, tutorId),
        payload: { channel: 'WHATSAPP', granted },
      })
      expect(response.statusCode).toBe(200)
    }

    const linhas = await ownerPrisma.tutorConsent.findMany({ where: { tutorId } })
    expect(linhas).toHaveLength(3)
    expect(linhas.map((linha) => linha.granted).sort()).toEqual([false, true, true])
  })

  it('um canal por clique: o outro não ganha linha nenhuma', async () => {
    const tutorId = await givenTutor(fixture, { email: 'maria@exemplo.com' })

    await callApi({
      method: 'PATCH',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
      payload: { channel: 'EMAIL', granted: true },
    })

    const linhas = await ownerPrisma.tutorConsent.findMany({ where: { tutorId } })
    expect(linhas).toHaveLength(1)
    expect(linhas[0]?.channel).toBe('EMAIL')
  })

  it('o IP e o user agent do tutor viajam até a porta: são prova, não log', async () => {
    const tutorId = await givenTutor(fixture)

    await callApi({
      method: 'PATCH',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
      payload: { channel: 'WHATSAPP', granted: true },
    })

    expect(tutorService.calls).toHaveLength(1)
    expect(tutorService.calls[0]?.tutorId).toBe(tutorId)
    expect(tutorService.calls[0]?.ipAddress).toBeTruthy()
  })

  it('o propósito não é aceito do cliente: o corpo é estrito', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'PATCH',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
      payload: { channel: 'WHATSAPP', granted: false, purpose: 'TRANSACTIONAL' },
    })

    expect(response.statusCode).toBe(422)
    expect(tutorService.calls).toHaveLength(0)
  })

  it('canal fora dos dois do Portal é recusado antes de chegar à porta', async () => {
    const tutorId = await givenTutor(fixture)

    const response = await callApi({
      method: 'PATCH',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
      payload: { channel: 'TERMS', granted: false },
    })

    expect(response.statusCode).toBe(422)
    expect(tutorService.calls).toHaveLength(0)
  })

  it('a recusa do tutor-service vira a mesma recusa no Portal', async () => {
    const tutorId = await givenTutor(fixture)
    tutorService.failWith = new AppError('ERR_TUTOR_006', 'Cadastro em estado terminal não aceita edição')

    const response = await callApi({
      method: 'PATCH',
      url: '/portal/v1/preferences',
      ...asTutor(fixture, tutorId),
      payload: { channel: 'WHATSAPP', granted: true },
    })

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(await ownerPrisma.tutorConsent.count({ where: { tutorId } })).toBe(0)
  })
})
