import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@petshop/db'
import {
  handleTaxiACaminho,
  handleTaxiChegou,
  handleTaxiEntregue,
  handleTaxiFalhou,
} from '../../src/modules/crm/consumers.js'
import {
  asAdmin,
  callApi,
  closeHarness,
  enableTaxi,
  givenAppointment,
  givenTaxiRide,
  givenTenant,
  installFakeMessagingPort,
  resetDatabase,
  type FakeMessaging,
  type TenantFixture,
} from './fixtures.js'

/** MOD-CRM-09 — os avisos do Taxi Dog. */

let fixture: TenantFixture
let messaging: FakeMessaging

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  messaging = installFakeMessagingPort()
})

afterAll(closeHarness)

async function ride(options: Parameters<typeof givenTaxiRide>[2] = {}) {
  const appointment = await givenAppointment(fixture)
  const rideId = await givenTaxiRide(fixture, appointment, options)
  return { rideId, ...appointment }
}

describe('avisos da corrida', () => {
  it('avisa o tutor quando o motorista sai, com a janela prometida (AC-01)', async () => {
    const { rideId, tutorId } = await ride({
      // 11h–12h UTC é 8h–9h em São Paulo, que é o fuso do tenant de teste.
      window: [new Date('2026-09-03T11:00:00Z'), new Date('2026-09-03T12:00:00Z')],
    })

    await handleTaxiACaminho({ tenantId: fixture.tenantId, rideId, notify: true })

    expect(messaging.requests).toHaveLength(1)
    const message = messaging.requests[0]!
    expect(message.templateKey).toBe('taxi_en_route')
    expect(message.tutorId).toBe(tutorId)
    expect(message.originType).toBe('TAXI_RIDE')
    expect(message.originId).toBe(rideId)
    // A promessa em português, no fuso do petshop — não um ISO em UTC.
    expect(message.variables['taxi.janela']).toBe('entre 8h e 9h')
    expect(message.variables['pets.lista']).toBe('Thor')
  })

  it('avisa a chegada e a entrega, cada uma com a sua chave de idempotência', async () => {
    const { rideId } = await ride()

    await handleTaxiChegou({ tenantId: fixture.tenantId, rideId, notify: true })
    await handleTaxiEntregue({ tenantId: fixture.tenantId, rideId, notify: true })

    expect(messaging.requests.map((m) => m.templateKey)).toEqual([
      'taxi_arrived',
      'taxi_delivered',
    ])
    // Uma chave só por corrida faria a segunda ser descartada como duplicata.
    const keys = new Set(messaging.requests.map((m) => m.dedupeKey))
    expect(keys.size).toBe(2)
  })

  it('conta o motivo da coleta frustrada em português, nunca o enum (AC-03)', async () => {
    const { rideId } = await ride({ failureReason: 'NO_ONE_HOME' })

    await handleTaxiFalhou({ tenantId: fixture.tenantId, rideId, notify: true })

    const message = messaging.requests[0]!
    expect(message.templateKey).toBe('taxi_failed')
    expect(message.variables['taxi.motivo']).toBe('não conseguimos encontrar ninguém no endereço')
    expect(message.variables['taxi.motivo']).not.toContain('NO_ONE_HOME')
  })

  it('cala quando o MOD-TAXI diz que o tutor não precisa saber', async () => {
    const { rideId } = await ride({ leg: 'DROPOFF' })

    // "Coletei" na perna de volta é o pet saindo do salão. Quem publicou já resolveu
    // isso — este serviço só obedece.
    await handleTaxiChegou({ tenantId: fixture.tenantId, rideId, notify: false })

    expect(messaging.requests).toHaveLength(0)
  })

  it('não avisa nada com a automação desligada', async () => {
    const { rideId } = await ride()
    await enableTaxi(fixture)

    await callApi({
      ...asAdmin(fixture),
      method: 'PATCH',
      url: '/v1/crm/automations/taxi_en_route',
      payload: { enabled: false },
    })

    await handleTaxiACaminho({ tenantId: fixture.tenantId, rideId, notify: true })
    expect(messaging.requests).toHaveLength(0)
  })

  it('ignora corrida que já não existe em vez de estourar o consumidor', async () => {
    await expect(
      handleTaxiACaminho({
        tenantId: fixture.tenantId,
        rideId: '00000000-0000-4000-8000-000000000000',
        notify: true,
      }),
    ).resolves.toBeUndefined()

    expect(messaging.requests).toHaveLength(0)
  })
})

describe('listagem de automações (AC-04)', () => {
  it('esconde as automações de taxi com o módulo desligado', async () => {
    const response = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: '/v1/crm/automations',
    })

    const keys = response.json().data.map((row: { key: string }) => row.key)
    // Configuração de um módulo desligado é ruído: quatro interruptores que não fazem
    // nada, no meio dos que fazem, ensinam o admin a não confiar na tela.
    expect(keys).not.toContain('taxi_en_route')
    expect(keys).toContain('appointment_reminder')
  })

  it('mostra as quatro, e ligadas, com o Taxi Dog no ar', async () => {
    await enableTaxi(fixture)

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'GET',
      url: '/v1/crm/automations',
    })

    const rows = response.json().data as { key: string; enabled: boolean }[]
    const taxi = rows.filter((row) => row.key.startsWith('taxi_'))
    expect(taxi).toHaveLength(4)
    // Nascem ligadas, ao contrário de "pet pronto": um tutor que não sabe que o
    // motorista está a caminho é a coleta frustrada que o módulo tenta evitar.
    expect(taxi.every((row) => row.enabled)).toBe(true)
  })

  it('a automação de taxi continua valendo mesmo escondida da listagem', async () => {
    const { rideId } = await ride()

    // O Taxi Dog está desligado nas configurações, mas a corrida existe — alguém a
    // criou antes de desligar. O aviso sai: o pet está na van agora, e esconder o
    // interruptor não é o mesmo que desligar a automação.
    await handleTaxiACaminho({ tenantId: fixture.tenantId, rideId, notify: true })

    expect(messaging.requests).toHaveLength(1)
  })
})

describe('variáveis da corrida', () => {
  it('escreve "às 8h" quando as duas pontas caem no mesmo minuto', async () => {
    // O CHECK `taxi_rides_window_check` exige fim > início, então a janela degenerada
    // possível é a de segundos. Sem esta guarda o tutor leria "entre 8h e 8h".
    const { rideId } = await ride({
      window: [new Date('2026-09-03T11:00:00Z'), new Date('2026-09-03T11:00:30Z')],
    })

    await handleTaxiACaminho({ tenantId: fixture.tenantId, rideId, notify: true })

    expect(messaging.requests[0]!.variables['taxi.janela']).toBe('às 8h')
  })

  it('mantém os minutos quando a grade de 15 não fecha na hora cheia', async () => {
    const { rideId } = await ride({
      window: [new Date('2026-09-03T11:15:00Z'), new Date('2026-09-03T12:15:00Z')],
    })

    await handleTaxiACaminho({ tenantId: fixture.tenantId, rideId, notify: true })

    expect(messaging.requests[0]!.variables['taxi.janela']).toBe('entre 8h15 e 9h15')
  })

  it('deixa o motivo vazio quando a corrida não falhou', async () => {
    const { rideId } = await ride()

    await handleTaxiEntregue({ tenantId: fixture.tenantId, rideId, notify: true })

    // Buraco na frase é melhor que "undefined" no celular do cliente — e o template de
    // entrega não usa a variável de qualquer modo.
    expect(messaging.requests[0]!.variables['taxi.motivo']).toBe('')
  })
})

describe('isolamento', () => {
  it('não enxerga a corrida do vizinho', async () => {
    const { rideId } = await ride()
    const vizinho = await givenTenant('Vizinho')

    // O mesmo id de corrida, o tenant errado: o RLS devolve nada, e o handler encerra
    // sem enfileirar em vez de mandar o aviso do pet alheio.
    await handleTaxiACaminho({ tenantId: vizinho.tenantId, rideId, notify: true })

    expect(messaging.requests).toHaveLength(0)
    await withTenant(fixture.tenantId, async (tx) => {
      expect(await tx.taxiRide.count()).toBe(1)
    })
  })
})
