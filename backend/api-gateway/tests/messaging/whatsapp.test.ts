import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import { dispatchTenant } from '../../src/modules/messaging/dispatch.js'
import {
  asAdmin,
  asRole,
  callAsService,
  callApi,
  callWebhook,
  closeHarness,
  enableMessaging,
  givenTenant,
  givenTutor,
  installFakeEmailPort,
  installFakeEvolution,
  resetDatabase,
  resetPorts,
  type FakeEvolution,
  type FakePort,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-CRM-01 — a conexão do WhatsApp do estabelecimento.
 *
 * O dublê fica **abaixo** do adaptador de canal: o que estes testes exercitam é o
 * caminho de verdade — a linha em `whatsapp_instances`, a chave cifrada com a DEK do
 * tenant, o hash do token, a máquina de estados e o efeito na fila. O que não acontece
 * é o HTTP com a Evolution.
 */

let fixture: TenantFixture
let evolution: FakeEvolution
let email: FakePort

beforeEach(async () => {
  await resetDatabase()
  resetPorts()
  fixture = await givenTenant()
  evolution = installFakeEvolution()
  email = installFakeEmailPort()
})

afterAll(closeHarness)

async function connect() {
  return callApi({
    ...asAdmin(fixture),
    method: 'POST',
    url: '/v1/messaging/whatsapp/connect',
  })
}

async function pair() {
  await connect()
  await callWebhook(evolution.lastToken(), {
    event: 'connection.update',
    data: { state: 'open', wuid: '5511999990000@s.whatsapp.net' },
  })
}

function readInstance() {
  return withTenant(fixture.tenantId, (tx) =>
    tx.whatsappInstance.findUnique({ where: { tenantId: fixture.tenantId } }),
  )
}

async function enqueue(tutorId: string, overrides: Record<string, unknown> = {}) {
  return callAsService(fixture, {
    method: 'POST',
    url: '/v1/messages',
    payload: {
      tutorId,
      templateKey: 'appointment_reminder',
      dedupeKey: `reminder:${tutorId}:${Math.random()}`,
      variables: { 'pets.lista': 'Thor', 'agendamento.data': 'quinta', 'agendamento.hora': '09:00' },
      ...overrides,
    },
  })
}

describe('conexão (MOD-CRM-01)', () => {
  it('cria a instância e devolve o QR code (AC-01)', async () => {
    const response = await connect()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('CONNECTING')
    expect(body.qrCode).toMatch(/^data:image\/png;base64,/)

    // O nome é `tenant-<slug>`: é o que aparece no log de quem opera o servidor.
    expect(evolution.created).toHaveLength(1)
    expect(evolution.created[0]!.instanceName).toMatch(/^tenant-teste-/)

    const row = await readInstance()
    expect(row?.status).toBe('CONNECTING')
    // O token cru nunca é persistido — só o hash, como o link de convite.
    expect(row?.webhookTokenHash).toHaveLength(64)
    expect(row?.webhookTokenHash).not.toBe(evolution.lastToken())
    // E a chave da instância fica cifrada com a DEK do tenant.
    expect(row?.apiKeyEncrypted).not.toContain('key-1')
  })

  it('grava o número e liga o canal quando o webhook diz que pareou (AC-02)', async () => {
    await connect()

    const response = await callWebhook(evolution.lastToken(), {
      event: 'connection.update',
      data: { state: 'open', wuid: '5511999990000@s.whatsapp.net' },
    })
    expect(response.statusCode).toBe(204)

    const row = await readInstance()
    expect(row?.status).toBe('CONNECTED')
    expect(row?.phoneE164).toBe('+5511999990000')
    expect(row?.connectedAt).not.toBeNull()
    // RN-06: o relógio do aquecimento começa aqui, e em nenhum outro lugar.
    expect(row?.warmupStartedAt).not.toBeNull()
  })

  it('dá um QR novo sem recriar a instância (AC-03)', async () => {
    await connect()
    const before = await readInstance()

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: '/v1/messaging/whatsapp/qr',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().qrCode).toMatch(/^data:image\/png;base64,/)
    // Uma criação só: recriar perderia a sessão e o `warmup_started_at` junto.
    expect(evolution.created).toHaveLength(1)
    expect(evolution.qrRequests).toHaveLength(1)
    expect((await readInstance())?.createdAt).toEqual(before?.createdAt)
  })

  it('não recria a instância quando o admin clica em conectar duas vezes', async () => {
    await connect()
    const second = await connect()

    expect(second.statusCode).toBe(201)
    expect(evolution.created).toHaveLength(1)
    // O segundo clique caiu no caminho do AC-03 — QR novo, mesma instância.
    expect(evolution.qrRequests).toHaveLength(1)
  })

  it('grava a linha antes de a instância existir no provedor', async () => {
    // A Evolution dispara o primeiro `qrcode.updated` em menos de um segundo. Quem
    // descobre o tenant é o hash do token, então a linha precisa estar no banco
    // **antes** — gravando depois, esse callback chega sem dono e leva 401, que ela
    // trata como definitivo e para de retentar. O pareamento então nunca conclui, sem
    // uma linha de erro do nosso lado.
    let resolvedDuringCreate: { tenantId: string } | null = null
    evolution.onCreateInstance(async (input) => {
      const { resolveWhatsappInstanceByTokenHash } = await import('@petshop/db')
      const { webhookTokenHash } = await import('../../src/modules/messaging/whatsapp.js')
      resolvedDuringCreate = await resolveWhatsappInstanceByTokenHash(
        webhookTokenHash(input.webhookToken),
      )
    })

    await connect()

    expect(resolvedDuringCreate).not.toBeNull()
    expect(resolvedDuringCreate!.tenantId).toBe(fixture.tenantId)
  })

  it('desfaz a linha quando o provedor recusa criar a instância', async () => {
    evolution.failNextCreate()

    const failed = await connect()
    expect(failed.statusCode).toBe(502)

    // Sem o desfazimento sobraria uma linha `CONNECTING` sem chave de instância, e o
    // clique seguinte cairia no `refreshQrCode`, que exige a chave e recusa — o dono
    // ficaria trancado fora do pareamento por um engasgo de rede.
    expect(await readInstance()).toBeNull()

    const retried = await connect()
    expect(retried.statusCode).toBe(201)
    expect((await readInstance())?.status).toBe('CONNECTING')
  })

  it('recusa a conexão para quem não é administrador (AC-06)', async () => {
    const response = await callApi({
      ...(await asRole(fixture, 'RECEPTIONIST')),
      method: 'POST',
      url: '/v1/messaging/whatsapp/connect',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('ERR_CRM_012')
    expect(evolution.created).toHaveLength(0)
  })

  it('deixa a recepção ver o estado da conexão', async () => {
    await pair()

    const response = await callApi({
      ...(await asRole(fixture, 'RECEPTIONIST')),
      method: 'GET',
      url: '/v1/messaging/whatsapp',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('CONNECTED')
    // Nem a chave da instância nem o token saem para a tela.
    expect(Object.keys(response.json())).not.toContain('apiKey')
  })
})

describe('webhook (RN-11)', () => {
  it('recusa token desconhecido sem dizer o que estava errado', async () => {
    await connect()

    const response = await callWebhook('token-inventado', {
      event: 'connection.update',
      data: { state: 'open' },
    })

    expect(response.statusCode).toBe(401)
    expect((await readInstance())?.status).toBe('CONNECTING')
  })

  it('aceita o token pela query, e não só pelo cabeçalho', async () => {
    await connect()
    const instance = await (await import('./fixtures.js')).getApp()

    const response = await instance.inject({
      method: 'POST',
      url: `/internal/v1/whatsapp/webhook?token=${encodeURIComponent(evolution.lastToken())}`,
      payload: { event: 'connection.update', data: { state: 'open' } },
    })

    expect(response.statusCode).toBe(204)
    expect((await readInstance())?.status).toBe('CONNECTED')
  })

  it('reconhece o giro do QR em vez de descartá-lo', async () => {
    await connect()

    const response = await callWebhook(evolution.lastToken(), {
      event: 'qrcode.updated',
      data: { qrcode: { base64: 'data:image/png;base64,R0lSQURP' } },
    })

    // O giro não muda estado — quem pareou é o `connection.update`. O que ele muda é o
    // código que a tela mostra: sem tratá-lo, a pessoa escaneava para sempre o
    // primeiro QR, que o provedor já havia descartado aos ~45 segundos.
    expect(response.statusCode).toBe(204)
    expect((await readInstance())?.status).toBe('CONNECTING')
  })

  it('responde 204 a evento que não muda estado, para a Evolution parar de reenviar', async () => {
    await connect()

    const response = await callWebhook(evolution.lastToken(), {
      event: 'messages.upsert',
      data: {},
    })

    expect(response.statusCode).toBe(204)
    expect((await readInstance())?.status).toBe('CONNECTING')
  })
})

describe('refazer a conexão (recuperação)', () => {
  async function recreate() {
    return callApi({
      ...asAdmin(fixture),
      method: 'POST',
      url: '/v1/messaging/whatsapp/recreate',
    })
  }

  it('apaga a instância no provedor e cria outra com identidade nova', async () => {
    await connect()
    const antes = await readInstance()
    const tokenAntigo = evolution.lastToken()

    const response = await recreate()
    expect(response.statusCode).toBe(201)

    // Apagar, e não só deslogar: `logout` preserva as chaves de identidade, e é
    // justamente a identidade que o WhatsApp passa a recusar. Sem este DELETE o QR novo
    // é recusado igual, e o petshop não tem como sair do estado.
    expect(evolution.deleted).toContain(antes!.instanceName)
    expect(evolution.created).toHaveLength(2)

    // Token novo: a linha antiga saiu e outra nasceu. Um webhook com o token velho não
    // pode mais ser reconhecido.
    expect(evolution.lastToken()).not.toBe(tokenAntigo)
    const depois = await readInstance()
    expect(depois?.status).toBe('CONNECTING')
    expect(depois?.webhookTokenHash).not.toBe(antes?.webhookTokenHash)
  })

  it('recusa refazer enquanto o WhatsApp está conectado', async () => {
    await pair()

    const response = await recreate()

    // Destrutivo não pode ficar a um clique de uma sessão que funciona: para refazer,
    // desconecte antes — e aí a decisão é explícita.
    expect(response.statusCode).toBe(409)
    expect((await readInstance())?.status).toBe('CONNECTED')
    expect(evolution.deleted).toHaveLength(0)
  })

  it('recusa refazer quando nunca houve conexão', async () => {
    const response = await recreate()

    expect(response.statusCode).toBe(409)
    expect(await readInstance()).toBeNull()
  })

  it('exige a permissão de administrador (AC-06)', async () => {
    await connect()

    // A recepção tem `crm:read` e `crm:manage`, e **não** `crm:connect_channel` — que
    // é exatamente o recorte que este AC exige. Antes da consolidação o teste montava
    // a lista de permissões à mão; agora usa o papel que a matriz define.
    const response = await callApi({
      ...(await asRole(fixture, 'RECEPTIONIST')),
      method: 'POST',
      url: '/v1/messaging/whatsapp/recreate',
    })

    expect(response.statusCode).toBe(403)
    expect(evolution.deleted).toHaveLength(0)
  })
})

describe('desconexão (AC-04)', () => {
  it('marca DISCONNECTED sem tocar na fila', async () => {
    await pair()

    await callWebhook(evolution.lastToken(), {
      event: 'connection.update',
      data: { state: 'close', statusReason: 401 },
    })

    const row = await readInstance()
    expect(row?.status).toBe('DISCONNECTED')
    expect(row?.lastError).toContain('401')
  })

  it('devolve a mensagem à fila em vez de matá-la quando o canal cai', async () => {
    await enableMessaging(fixture)
    await pair()
    const tutorId = await givenTutor(fixture, { email: null })

    const enqueued = await enqueue(tutorId)
    expect(enqueued.json().status).toBe('QUEUED')

    // O celular do dono ficou sem internet entre o enfileiramento e o despacho.
    await callWebhook(evolution.lastToken(), {
      event: 'connection.update',
      data: { state: 'close' },
    })

    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findFirstOrThrow({ where: { tutorId } }),
    )
    // Nem `DEAD`, nem tentativa contada: três dias de queda custam três dias de
    // atraso, não a fila inteira.
    expect(message.status).toBe('SCHEDULED')
    expect(message.attempts).toBe(0)
    expect(message.scheduledFor).not.toBeNull()
  })
})

describe('banimento (AC-05)', () => {
  it('desliga o canal e leva a fila para o e-mail — inclusive a mensagem que o descobriu', async () => {
    await enableMessaging(fixture)
    await pair()

    const tutorId = await givenTutor(fixture)
    const outroTutor = await givenTutor(fixture)
    await enqueue(tutorId)
    await enqueue(outroTutor)

    evolution.failNextSend('WHATSAPP_BANNED', 'account is banned')
    await dispatchTenant(fixture.tenantId, { jitter: false })

    expect((await readInstance())?.status).toBe('BANNED')

    const messages = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findMany({ orderBy: { createdAt: 'asc' } }),
    )
    // As duas: a que estava esperando **e** a que estava no ar quando o provedor
    // recusou. Deixar a segunda para trás seria perder exatamente uma mensagem por
    // banimento, e sempre a mais recente.
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message.channel).toBe('EMAIL')
      // Nenhuma tentativa contada: elas não erraram, o canal morreu.
      expect(message.attempts).toBe(0)
      expect(message.status).not.toBe('DEAD')
    }

    // A segunda já sai nesta mesma passada — o lote continua depois da conversão. A
    // outra sai na seguinte, e as duas chegam.
    await dispatchTenant(fixture.tenantId, { jitter: false })
    expect(email.sent).toHaveLength(2)
    expect(evolution.sent).toHaveLength(0)
  })

  it('bloqueia, em vez de apagar, quem não tem e-mail para onde cair', async () => {
    await enableMessaging(fixture)
    await pair()

    const semEmail = await givenTutor(fixture, { email: null })
    await enqueue(semEmail)

    evolution.failNextSend('WHATSAPP_BANNED', 'account is banned')
    await dispatchTenant(fixture.tenantId, { jitter: false })

    const message = await withTenant(fixture.tenantId, (tx) =>
      tx.message.findFirstOrThrow({ where: { tutorId: semEmail } }),
    )
    // O painel precisa poder dizer por que aquela pessoa não recebeu.
    expect(message.status).toBe('BLOCKED')
    expect(message.blockReason).toBe('NO_CHANNEL')
  })
})

describe('disponibilidade por tenant', () => {
  it('o petshop que pareou manda por WhatsApp; o vizinho, por e-mail', async () => {
    await enableMessaging(fixture)
    await pair()

    const outro = await givenTenant('Vizinho')
    await enableMessaging(outro)

    const conectado = await givenTutor(fixture)
    const semWhatsapp = await givenTutor(outro)

    await enqueue(conectado)
    await callAsService(outro, {
      method: 'POST',
      url: '/v1/messages',
      payload: {
        tutorId: semWhatsapp,
        templateKey: 'appointment_reminder',
        dedupeKey: `reminder:${semWhatsapp}`,
        variables: { 'pets.lista': 'Mel', 'agendamento.data': 'sexta', 'agendamento.hora': '10:00' },
      },
    })

    const [aqui, la] = await Promise.all([
      withTenant(fixture.tenantId, (tx) =>
        tx.message.findFirstOrThrow({ where: { tutorId: conectado } }),
      ),
      withTenant(outro.tenantId, (tx) =>
        tx.message.findFirstOrThrow({ where: { tutorId: semWhatsapp } }),
      ),
    ])

    // O mesmo processo, a mesma cascata `AUTO`, dois canais — que é a razão de
    // `ChannelPort.isAvailable` receber o tenant.
    expect(aqui.channel).toBe('WHATSAPP')
    expect(la.channel).toBe('EMAIL')
  })
})

describe('aquecimento do número (RN-06)', () => {
  it('limita o teto diário nos primeiros dias, mesmo para transacional', async () => {
    // `dailyCap` alto de propósito: o que segura o envio aqui é o aquecimento, e não a
    // configuração do petshop — é justamente essa a diferença que a RN-06 introduz.
    await enableMessaging(fixture, { dailyCap: 500 })
    await pair()

    const connection = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: '/v1/messaging/whatsapp',
    })

    const body = connection.json()
    // Dia 1: `min(500, 30 × 1)`.
    expect(body.effectiveDailyCap).toBe(30)
    expect(body.warmupDaysLeft).toBe(7)
  })

  it('devolve o teto cheio depois de sete dias', async () => {
    await enableMessaging(fixture, { dailyCap: 500 })
    await pair()

    const oitoDiasAtras = new Date(Date.now() - 8 * 86_400_000)
    await withTenant(fixture.tenantId, (tx) =>
      tx.whatsappInstance.update({
        where: { tenantId: fixture.tenantId },
        data: { warmupStartedAt: oitoDiasAtras },
      }),
    )

    const connection = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: '/v1/messaging/whatsapp',
    })

    expect(connection.json().effectiveDailyCap).toBe(500)
    expect(connection.json().warmupDaysLeft).toBeNull()
  })

  it('não reinicia o aquecimento quando a conexão apenas cai e volta', async () => {
    await pair()
    const primeiro = (await readInstance())?.warmupStartedAt

    await callWebhook(evolution.lastToken(), {
      event: 'connection.update',
      data: { state: 'close' },
    })
    await callWebhook(evolution.lastToken(), {
      event: 'connection.update',
      data: { state: 'open', wuid: '5511999990000@s.whatsapp.net' },
    })

    // Zerar o contador a cada oscilação de rede prenderia o petshop em trinta
    // mensagens por dia para sempre.
    expect((await readInstance())?.warmupStartedAt).toEqual(primeiro)
  })
})

describe('agrupamento por janela (RN-08)', () => {
  it('junta duas mensagens da mesma categoria para o mesmo tutor em cinco minutos', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    // O caso do AC-02 de MOD-CRM-09: o taxi entrega e o atendimento conclui no mesmo
    // minuto, e o tutor não pode receber duas notificações sobre o mesmo fato.
    const primeira = await enqueue(tutorId, { templateKey: 'taxi_delivered' })
    const segunda = await enqueue(tutorId, { templateKey: 'taxi_arrived' })

    expect(primeira.json().status).toBe('QUEUED')
    expect(segunda.json().status).toBe('MERGED')

    await dispatchTenant(fixture.tenantId, { jitter: false })

    // Uma mensagem no ar, com as duas linhas dentro.
    expect(email.sent.length + evolution.sent.length).toBe(1)
  })

  it('não agrupa nem espera o worker quando a mensagem é `urgent`', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    // A mensagem irmã existe e está na janela: sem `urgent`, o código seria absorvido
    // por ela e sairia dentro de um lembrete de banho — quando saísse.
    await enqueue(tutorId, { templateKey: 'appointment_reminder' })

    const codigo = await enqueue(tutorId, {
      templateKey: 'portal_codigo_acesso',
      variables: { 'portal.codigo': '123456' },
      urgent: true,
    })

    expect(codigo.json().status).not.toBe('MERGED')

    /**
     * E o despacho **já aconteceu**, sem `dispatchTenant` neste teste.
     *
     * É o ponto do `urgent`: o worker varre a cada minuto, e um código de dez minutos
     * que sai no sétimo já chegou tarde para quem está com a tela aberta esperando.
     */
    expect(email.sent.length + evolution.sent.length).toBeGreaterThan(0)
  })

  it('não agrupa categorias diferentes', async () => {
    await enableMessaging(fixture)
    // Marketing exige consentimento; sem ele a mensagem nasceria bloqueada e o teste
    // provaria outra coisa.
    const tutorId = await givenTutor(fixture, { marketing: { whatsapp: true, email: true } })

    await enqueue(tutorId, { templateKey: 'taxi_delivered' })
    const transacional = await enqueue(tutorId, { templateKey: 'appointment_reminder' })

    // Juntar um aviso de taxi (OPERATIONAL, que atravessa a janela de silêncio) com
    // outra categoria faria a segunda sair no horário da primeira.
    expect(transacional.json().status).not.toBe('MERGED')
  })

  it('não agrupa fora da janela de cinco minutos', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    await enqueue(tutorId, { templateKey: 'taxi_delivered' })

    // Envelhece a primeira para além da janela.
    await withTenant(fixture.tenantId, (tx) =>
      tx.message.updateMany({
        where: { tutorId },
        data: { createdAt: new Date(Date.now() - 6 * 60_000) },
      }),
    )

    const segunda = await enqueue(tutorId, { templateKey: 'taxi_arrived' })
    expect(segunda.json().status).toBe('QUEUED')
  })

  it('reconhece a reentrega do broker em vez de concatenar de novo', async () => {
    await enableMessaging(fixture)
    const tutorId = await givenTutor(fixture)

    await enqueue(tutorId, { templateKey: 'taxi_delivered', dedupeKey: `taxi:${tutorId}` })
    const repetida = await enqueue(tutorId, {
      templateKey: 'taxi_arrived',
      dedupeKey: `chegou:${tutorId}`,
    })
    expect(repetida.json().status).toBe('MERGED')

    // O mesmo evento chega de novo pelo DLX. É a linha `MERGED` que guarda o
    // `dedupe_key` e impede o parágrafo de entrar duas vezes.
    const reentrega = await callAsService(fixture, {
      method: 'POST',
      url: '/v1/messages',
      payload: {
        tutorId,
        templateKey: 'taxi_arrived',
        dedupeKey: `chegou:${tutorId}`,
        variables: { 'pets.lista': 'Thor' },
      },
    })
    expect(reentrega.statusCode).toBe(200)

    const total = await withTenant(fixture.tenantId, (tx) => tx.message.count({ where: { tutorId } }))
    expect(total).toBe(2)
  })
})
