import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  callEmailWebhook,
  closeHarness,
  enableMessaging,
  getApp,
  givenDocument,
  givenTenant,
  givenTutor,
  installFakeDocumentStorage,
  installFakeEmailPort,
  installFakeWhatsAppPort,
  ownerPrisma,
  resetDatabase,
  resetPorts,
  authHeaders,
  RESEND_WEBHOOK_SECRET,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-NOTIF fatia 1 — destinatário de dois tipos, gates por tipo, anexo e o retorno do
 * provedor (PRD notificacoes_email_12 §3).
 */

let fixture: TenantFixture
let email: FakePort
let objects: Map<string, Buffer>

beforeAll(async () => {
  await getApp()
})

afterAll(async () => {
  await closeHarness()
})

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  email = installFakeEmailPort()
  objects = installFakeDocumentStorage()
  fixture = await givenTenant()
})

/**
 * O administrador, com o token que o Admin apresentaria. As permissões saem da matriz
 * pelo `membership`, e não de uma lista aqui — `TENANT_ADMIN` tem as três de CRM.
 */
function asAdmin() {
  return authHeaders({ clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId })
}

async function enqueue(body: Record<string, unknown>) {
  const app = await getApp()
  return app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: asAdmin(),
    payload: body,
  })
}

async function dispatchNow() {
  const { dispatchTenant } = await import('../../src/modules/messaging/dispatch.js')
  return dispatchTenant(fixture.tenantId, { jitter: false })
}

async function messageRow(id: string) {
  return withTenant(fixture.tenantId, (tx) => tx.message.findUniqueOrThrow({ where: { id } }))
}

// ─── MOD-NOTIF-01 — destinatário de dois tipos ───────────────────────────────

describe('MOD-NOTIF-01 — destinatário de dois tipos', () => {
  it('AC-01: mensagem de equipe percorre a mesma fila e o mesmo despacho', async () => {
    await enableMessaging(fixture)

    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'equipe-1',
      variables: {},
    })

    expect(response.statusCode).toBe(202)
    const row = await messageRow(response.json<{ id: string }>().id)
    expect(row.recipientKind).toBe('USER')
    expect(row.userId).toBe(fixture.userId)
    expect(row.tutorId).toBeNull()
    expect(row.status).toBe('QUEUED')

    await dispatchNow()
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]?.to).toBe(fixture.userEmail)
  })

  it('AC-02: destinatário ambíguo é 422, com os dois e com nenhum', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const ambos = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      tutorId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'ambos',
    })
    expect(ambos.statusCode).toBe(422)

    const nenhum = await enqueue({
      templateKey: 'appointment_reminder',
      dedupeKey: 'nenhum',
    })
    expect(nenhum.statusCode).toBe(422)
  })

  it('AC-02: o CHECK do banco recusa a linha incoerente, não só o schema', async () => {
    await expect(
      ownerPrisma.$executeRawUnsafe(
        `INSERT INTO messages
           (tenant_id, recipient_kind, tutor_id, user_id, channel, category,
            template_key, to_encrypted, to_hash, body_encrypted, dedupe_key)
         VALUES ($1::uuid, 'USER', NULL, NULL, 'EMAIL', 'TRANSACTIONAL',
                 'x', 'x', repeat('a', 64), 'x', 'check-1')`,
        fixture.tenantId,
      ),
    ).rejects.toThrow(/messages_recipient_check/)
  })

  it('AC-03: o e-mail do usuário abre a chave de plataforma, não a DEK do tenant', async () => {
    await enableMessaging(fixture)

    // A prova é indireta e é a que importa: o endereço que saiu é o texto em claro que
    // a fixture cifrou com `encryptPlatform`. Abrir a DEK do tenant devolveria lixo, e
    // a mensagem nasceria bloqueada por falta de canal.
    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'chave-1',
    })
    await dispatchNow()

    expect(response.statusCode).toBe(202)
    expect(email.sent[0]?.to).toBe(fixture.userEmail)
  })

  it('AC-04: vínculo encerrado entre a fila e o envio vira BLOCKED/NO_CHANNEL', async () => {
    await enableMessaging(fixture)
    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'ex-membro',
    })
    const id = response.json<{ id: string }>().id

    await ownerPrisma.membership.updateMany({
      where: { tenantId: fixture.tenantId, userId: fixture.userId },
      data: { status: 'REMOVED' },
    })

    await dispatchNow()
    const row = await messageRow(id)
    expect(row.status).toBe('BLOCKED')
    expect(row.blockReason).toBe('NO_CHANNEL')
    // A linha continua de pé: é a prova de que a mensagem foi enviada a um ex-membro.
    expect(row.userId).toBe(fixture.userId)
    expect(email.sent).toHaveLength(0)
  })

  it('AC-05: o parque existente nasce TUTOR sem backfill', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    const response = await enqueue({
      tutorId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'antigo-1',
    })
    const row = await messageRow(response.json<{ id: string }>().id)
    expect(row.recipientKind).toBe('TUTOR')
  })
})

// ─── MOD-NOTIF-02 — gates por tipo ───────────────────────────────────────────

describe('MOD-NOTIF-02 — gates por tipo de destinatário', () => {
  it('AC-01: a equipe não passa pelo consentimento nem pela janela de silêncio', async () => {
    // Janela fechada o dia inteiro e nenhum consentimento registrado: um tutor seria
    // adiado ou bloqueado; o membro da equipe sai agora.
    await enableMessaging(fixture, { quietStartMin: 8 * 60, quietEndMin: 8 * 60 + 1 })

    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'sem-janela',
    })
    const row = await messageRow(response.json<{ id: string }>().id)

    expect(row.status).toBe('QUEUED')
    expect(row.scheduledFor).toBeNull()
  })

  it('AC-02: supressão do endereço vale para a equipe', async () => {
    await enableMessaging(fixture)
    const app = await getApp()
    await app.inject({
      method: 'POST',
      url: '/v1/messaging/suppressions',
      headers: asAdmin(),
      payload: { channel: 'EMAIL', address: fixture.userEmail, reason: 'MANUAL' },
    })

    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'suprimido-1',
    })
    const row = await messageRow(response.json<{ id: string }>().id)

    expect(row.status).toBe('BLOCKED')
    expect(row.blockReason).toBe('SUPPRESSED')
  })

  it('AC-03: marketing para a equipe é 422', async () => {
    await enableMessaging(fixture)
    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'campaign_broadcast',
      dedupeKey: 'oferta-equipe',
      variables: { 'campanha.texto': 'promoção' },
    })
    expect(response.statusCode).toBe(422)
  })

  it('equipe por WhatsApp é recusado em vez de cair para o e-mail em silêncio', async () => {
    await enableMessaging(fixture)
    const response = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      channel: 'WHATSAPP',
      templateKey: 'appointment_reminder',
      dedupeKey: 'equipe-wa',
    })
    expect(response.statusCode).toBe(422)
  })

  it('AC-04: o motor desligado não cala o transacional de equipe', async () => {
    // `enabled` nasce falso e o tenant não o ligou: um tutor levaria ERR_CRM_013.
    const tutorId = await givenTutor(fixture)
    const doTutor = await enqueue({
      tutorId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'desligado-tutor',
    })
    expect(doTutor.statusCode).toBe(409)

    const daEquipe = await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'desligado-equipe',
    })
    expect(daEquipe.statusCode).toBe(202)

    // E **sai**: aceitar no enfileiramento e o worker pular o tenant inteiro seria a
    // mesma mensagem perdida, só mais tarde.
    await dispatchNow()
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]?.to).toBe(fixture.userEmail)
  })
})

// ─── MOD-NOTIF-05 — anexos ───────────────────────────────────────────────────

describe('MOD-NOTIF-05 — anexos', () => {
  it('AC-01: o documento arquivado viaja anexo e a mensagem guarda a referência', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { phone: '' })
    const documentId = await givenDocument(fixture, { tutorId, storage: objects })

    const response = await enqueue({
      tutorId,
      documentId,
      channel: 'EMAIL',
      templateKey: 'appointment_reminder',
      dedupeKey: 'anexo-1',
    })
    await dispatchNow()

    const row = await messageRow(response.json<{ id: string }>().id)
    expect(row.documentId).toBe(documentId)
    expect(row.status).toBe('SENT')
    expect(email.sent[0]?.attachment).toMatch(/^recibo-2026-\d+\.pdf$/)
    // O corpo cifrado guarda texto, nunca bytes.
    expect(row.bodyEncrypted).not.toContain('PDF')
  })

  it('AC-02: acima do teto o e-mail sai com link, e a trilha registra a troca', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { phone: '' })
    const documentId = await givenDocument(fixture, {
      tutorId,
      storage: objects,
      sizeBytes: 9 * 1024 * 1024,
    })

    const response = await enqueue({
      tutorId,
      documentId,
      channel: 'EMAIL',
      templateKey: 'appointment_reminder',
      dedupeKey: 'anexo-grande',
    })
    await dispatchNow()

    const id = response.json<{ id: string }>().id
    expect(email.sent[0]?.attachment).toBeNull()

    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id, event: 'SENT' } }),
    )
    expect(events[0]?.raw).toMatchObject({ attachment: 'link', reason: 'TOO_LARGE' })
  })

  it('AC-03: no WhatsApp o anexo vira link, sempre', async () => {
    await enableMessaging(fixture)
    const whatsapp = installFakeWhatsAppPort()
    const tutorId = await givenTutor(fixture)
    const documentId = await givenDocument(fixture, { tutorId, storage: objects })

    const response = await enqueue({
      tutorId,
      documentId,
      channel: 'WHATSAPP',
      templateKey: 'appointment_reminder',
      dedupeKey: 'anexo-wa',
    })
    await dispatchNow()

    const id = response.json<{ id: string }>().id
    expect(whatsapp.sent[0]?.attachment).toBeNull()
    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id, event: 'SENT' } }),
    )
    expect(events[0]?.raw).toMatchObject({ attachment: 'link', reason: 'WHATSAPP' })
  })

  it('AC-04: documento pendente adia a mensagem em vez de mandá-la vazia', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { phone: '' })
    const documentId = await givenDocument(fixture, { tutorId, status: 'PENDING' })

    const response = await enqueue({
      tutorId,
      documentId,
      channel: 'EMAIL',
      templateKey: 'appointment_reminder',
      dedupeKey: 'anexo-pendente',
    })
    await dispatchNow()

    const row = await messageRow(response.json<{ id: string }>().id)
    expect(row.status).toBe('SCHEDULED')
    expect(row.scheduledFor).not.toBeNull()
    // Nada falhou: a espera não consome tentativa.
    expect(row.attempts).toBe(0)
    expect(email.sent).toHaveLength(0)
  })

  it('documento anulado entre a fila e o envio vira CANCELLED, não BLOCKED', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { phone: '' })
    const documentId = await givenDocument(fixture, { tutorId, storage: objects })

    const response = await enqueue({
      tutorId,
      documentId,
      channel: 'EMAIL',
      templateKey: 'appointment_reminder',
      dedupeKey: 'anexo-anulado',
    })
    await withTenant(fixture.tenantId, (tx) =>
      tx.document.update({
        where: { id: documentId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      }),
    )
    await dispatchNow()

    const row = await messageRow(response.json<{ id: string }>().id)
    // Não houve impedimento do destinatário: foi o assunto que deixou de existir.
    expect(row.status).toBe('CANCELLED')
    expect(row.blockReason).toBeNull()
    expect(email.sent).toHaveLength(0)
  })

  it('AC-05: o link do documento é a página do Portal, nunca a URL assinada', async () => {
    const { documentsUrlOf } = await import('../../src/modules/messaging/attachments.js')

    // O endereço que o motor oferece ao template. É a página que pede a sessão do
    // tutor e assina a URL do outro lado — nunca a credencial de quinze minutos, que
    // no histórico e na caixa de entrada seria credencial vazada.
    const link = documentsUrlOf('petshop-do-joao')
    expect(link).toMatch(/\/portal\/documentos$/)
    expect(link).not.toContain('assinada')
    expect(link).not.toContain('X-Amz')
  })

  it('AC-05: nada do bucket atravessa o corpo gravado nem o que sai', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { phone: '' })
    const documentId = await givenDocument(fixture, { tutorId, storage: objects })

    const response = await enqueue({
      tutorId,
      documentId,
      channel: 'EMAIL',
      templateKey: 'appointment_reminder',
      dedupeKey: 'anexo-link',
    })
    await dispatchNow()

    const row = await messageRow(response.json<{ id: string }>().id)
    const corpo = email.sent[0]?.body ?? ''
    for (const texto of [corpo, row.bodyEncrypted]) {
      expect(texto).not.toContain('assinada=1')
      expect(texto).not.toContain('r2.test')
    }
  })
})

// ─── MOD-NOTIF-10 — retorno do provedor ──────────────────────────────────────

describe('MOD-NOTIF-10 — retorno do provedor', () => {
  async function sentMessage(): Promise<{ id: string; providerMessageId: string }> {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture, { phone: '', marketing: { email: true } })
    const response = await enqueue({
      tutorId,
      channel: 'EMAIL',
      templateKey: 'appointment_reminder',
      dedupeKey: `webhook-${randomKey()}`,
    })
    const id = response.json<{ id: string }>().id
    await dispatchNow()
    // O dublê responde `fake-N`; o webhook casa por `provider = 'resend'`, então a
    // linha precisa dizer que foi o Resend quem entregou.
    await ownerPrisma.$executeRawUnsafe(
      `UPDATE messages SET provider = 'resend', provider_message_id = $1 WHERE id = $2::uuid`,
      'email_abc',
      id,
    )
    return { id, providerMessageId: 'email_abc' }
  }

  function randomKey() {
    return Math.random().toString(36).slice(2, 10)
  }

  it('AC-01: bounce suprime o endereço e leva a mensagem a FAILED', async () => {
    const { id } = await sentMessage()

    const response = await callEmailWebhook({
      type: 'email.bounced',
      data: { email_id: 'email_abc' },
    })
    expect(response.statusCode).toBe(204)

    const row = await messageRow(id)
    expect(row.status).toBe('FAILED')

    const suppressions = await withTenant(fixture.tenantId, (tx) =>
      tx.messagingSuppression.findMany(),
    )
    expect(suppressions).toHaveLength(1)
    expect(suppressions[0]?.reason).toBe('HARD_BOUNCE')

    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id, event: 'BOUNCED' } }),
    )
    expect(events).toHaveLength(1)
  })

  it('AC-02: reclamação suprime e publica a revogação do marketing', async () => {
    const { id } = await sentMessage()

    const response = await callEmailWebhook({
      type: 'email.complained',
      data: { email_id: 'email_abc' },
    })
    expect(response.statusCode).toBe(204)

    const row = await messageRow(id)
    expect(row.errorCode).toBe('COMPLAINT')
    const suppressions = await withTenant(fixture.tenantId, (tx) =>
      tx.messagingSuppression.findMany(),
    )
    expect(suppressions).toHaveLength(1)
    // A revogação em si é do tutor-service, que consome `mensagem.reclamada`: este
    // serviço lê consentimento e nunca o grava.
  })

  it('AC-03: sem assinatura válida é 401, e nada é processado', async () => {
    const { id } = await sentMessage()

    const semAssinatura = await (await getApp()).inject({
      method: 'POST',
      url: '/internal/v1/email/webhook',
      headers: { 'content-type': 'application/json' },
      payload: { type: 'email.bounced', data: { email_id: 'email_abc' } },
    })
    expect(semAssinatura.statusCode).toBe(401)

    const outroSegredo = await callEmailWebhook(
      { type: 'email.bounced', data: { email_id: 'email_abc' } },
      { secret: 'whsec_' + Buffer.from('outro-segredo').toString('base64') },
    )
    expect(outroSegredo.statusCode).toBe(401)

    const antigo = await callEmailWebhook(
      { type: 'email.bounced', data: { email_id: 'email_abc' } },
      { timestamp: Math.floor(Date.now() / 1000) - 3600 },
    )
    expect(antigo.statusCode).toBe(401)

    const row = await messageRow(id)
    expect(row.status).toBe('SENT')
    const suppressions = await withTenant(fixture.tenantId, (tx) =>
      tx.messagingSuppression.findMany(),
    )
    expect(suppressions).toHaveLength(0)
  })

  it('AC-04: entrega é registrada; abertura não', async () => {
    const { id } = await sentMessage()

    await callEmailWebhook({ type: 'email.delivered', data: { email_id: 'email_abc' } })
    let row = await messageRow(id)
    expect(row.status).toBe('DELIVERED')
    expect(row.deliveredAt).not.toBeNull()

    await callEmailWebhook({ type: 'email.opened', data: { email_id: 'email_abc' } })
    row = await messageRow(id)
    expect(row.readAt).toBeNull()
    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id } }),
    )
    expect(events.map((event) => event.event)).toEqual(['SENT', 'DELIVERED'])
  })

  it('AC-05: um delivered atrasado não desfaz o bounce', async () => {
    const { id } = await sentMessage()

    await callEmailWebhook({ type: 'email.bounced', data: { email_id: 'email_abc' } })
    await callEmailWebhook({ type: 'email.delivered', data: { email_id: 'email_abc' } })

    const row = await messageRow(id)
    expect(row.status).toBe('FAILED')
    // O evento antigo entra na trilha mesmo sem mover o status.
    const events = await withTenant(fixture.tenantId, (tx) =>
      tx.messageEvent.findMany({ where: { messageId: id }, orderBy: { occurredAt: 'asc' } }),
    )
    expect(events.map((event) => event.event)).toContain('DELIVERED')
  })

  it('o segredo do teste é o mesmo do ambiente do harness', () => {
    expect(process.env.RESEND_WEBHOOK_SECRET).toBe(RESEND_WEBHOOK_SECRET)
  })
})

// ─── MOD-NOTIF-11 — histórico da equipe ──────────────────────────────────────

describe('MOD-NOTIF-11 — histórico', () => {
  it('AC-01: o painel lista as duas relações e filtra por destinatário', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    await enqueue({ tutorId, templateKey: 'appointment_reminder', dedupeKey: 'lista-tutor' })
    await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'lista-equipe',
    })

    const app = await getApp()
    const todas = await app.inject({ method: 'GET', url: '/v1/messages', headers: asAdmin() })
    expect(todas.json<{ total: number }>().total).toBe(2)

    const equipe = await app.inject({
      method: 'GET',
      url: '/v1/messages?recipientKind=USER',
      headers: asAdmin(),
    })
    const page = equipe.json<{ data: { recipientName: string; recipientKind: string }[] }>()
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.recipientKind).toBe('USER')
    expect(page.data[0]?.recipientName).toBe('Atendente de Teste')
  })

  it('AC-02: a aba da ficha do tutor não mistura as duas relações', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)
    await enqueue({ tutorId, templateKey: 'appointment_reminder', dedupeKey: 'ficha-tutor' })
    await enqueue({
      recipientKind: 'USER',
      userId: fixture.userId,
      templateKey: 'appointment_reminder',
      dedupeKey: 'ficha-equipe',
    })

    const app = await getApp()
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tutors/${tutorId}/messages`,
      headers: asAdmin(),
    })
    expect(response.json<{ total: number }>().total).toBe(1)
  })
})
