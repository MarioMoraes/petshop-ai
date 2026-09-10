import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  callPlatform,
  closeHarness,
  givenPlatformAdmin,
  givenUser,
  ownerPrisma,
  resetDatabase,
  seedTenant,
  type PlatformUser,
} from './fixtures.js'
import type { AlertMail, AlertMailerPort } from '../../src/modules/platform/alert-mailer.js'

/** MOD-ADMIN-06 — os alertas operacionais. */

const { evaluateAlerts } = await import('../../src/modules/platform/alerts.js')
const { setAlertMailerPort } = await import('../../src/modules/platform/alert-mailer.js')

let admin: PlatformUser

/** O que saiu por e-mail. É a única prova de que o alarme chegou a alguém. */
let enviados: { mail: AlertMail; to: string[] }[] = []

const mailerDuble: AlertMailerPort = {
  async sendAlert(mail, to) {
    enviados.push({ mail, to })
    return true
  },
}

beforeEach(async () => {
  await resetDatabase()
  enviados = []
  setAlertMailerPort(mailerDuble)
  admin = await givenPlatformAdmin('Ana da Plataforma')
})

afterEach(() => {
  setAlertMailerPort(null)
})

afterAll(closeHarness)

/** Uma mensagem parada há mais de quinze minutos — a condição da regra do PRD. */
async function givenMensagemPresa(tenantId: string, quantas = 1): Promise<void> {
  const presa = new Date(Date.now() - 30 * 60_000)

  for (let indice = 0; indice < quantas; indice += 1) {
    const suffix = randomBytes(6).toString('hex')
    await ownerPrisma.message.create({
      data: {
        tenantId,
        recipientKind: 'USER',
        userId: admin.userId,
        channel: 'EMAIL',
        category: 'TRANSACTIONAL',
        templateKey: 'teste',
        toEncrypted: 'v1:x:x:x',
        toHash: `to-${suffix}`.padEnd(64, '0'),
        bodyEncrypted: 'v1:x:x:x',
        dedupeKey: `dedupe-${suffix}`,
        status: 'QUEUED',
        createdAt: presa,
      },
    })
  }
}

async function alertas(rule = 'message_queue_stuck') {
  return ownerPrisma.platformAlert.findMany({ where: { rule }, orderBy: { firstSeenAt: 'asc' } })
}

describe('MOD-ADMIN-06 — acender', () => {
  /**
   * AC-01 — **duas avaliações**, e a primeira não notifica ninguém.
   *
   * Um pico de um minuto na fila não é incidente. O que interessa é a condição que
   * permanece, e é ela que a segunda avaliação confirma.
   */
  it('AC-01: a condição precisa valer em duas avaliações seguidas', async () => {
    const tenant = await seedTenant('petshop-fila')
    await givenMensagemPresa(tenant.tenantId, 3)

    await evaluateAlerts()

    const primeira = await alertas()
    expect(primeira).toHaveLength(1)
    expect(primeira[0]).toMatchObject({ status: 'PENDING', firedAt: null })
    expect(enviados).toHaveLength(0)

    await evaluateAlerts()

    const segunda = await alertas()
    expect(segunda[0]?.status).toBe('FIRING')
    expect(segunda[0]?.firedAt).not.toBeNull()
    expect(Number(segunda[0]?.value)).toBe(3)
    expect(enviados).toHaveLength(1)
    expect(enviados[0]?.mail.subject).toContain('Mensagens presas')
  })

  /**
   * AC-02 — o alarme não usa o que quebrou para avisar.
   *
   * A suíte roda com o broker **desligado** (`DISABLE_EVENTS`), que é a forma mais direta
   * de provar o RN-10: a notificação sai mesmo sem RabbitMQ, porque ela é um POST ao
   * provedor de e-mail e não uma mensagem na fila.
   */
  it('AC-02: notifica com o broker desligado', async () => {
    const tenant = await seedTenant('petshop-sem-broker')
    await givenMensagemPresa(tenant.tenantId)

    await evaluateAlerts()
    await evaluateAlerts()

    expect(enviados).toHaveLength(1)
    expect(enviados[0]?.to).toHaveLength(1)
  })

  it('o destinatário padrão são os administradores de plataforma ativos', async () => {
    const tenant = await seedTenant('petshop-destino')
    await givenMensagemPresa(tenant.tenantId)
    await givenPlatformAdmin('Bruno da Plataforma')

    await evaluateAlerts()
    await evaluateAlerts()

    expect(enviados[0]?.to).toHaveLength(2)
    expect(enviados[0]?.to).toContain(admin.email)
  })

  /**
   * AC-04 — tempestade.
   *
   * Sete estabelecimentos com a fila presa no mesmo minuto são **um** incidente. Uma
   * notificação por tenant encheria a caixa de quem precisa reagir, que é o jeito mais
   * rápido de transformar alarme em ruído.
   */
  it('AC-04: uma notificação por regra, com a contagem e os cinco primeiros', async () => {
    for (let indice = 0; indice < 7; indice += 1) {
      const tenant = await seedTenant(`petshop-tempestade-${indice}`)
      await givenMensagemPresa(tenant.tenantId)
    }

    await evaluateAlerts()
    await evaluateAlerts()

    expect(await alertas()).toHaveLength(7)
    expect(enviados).toHaveLength(1)

    const corpo = enviados[0]?.mail.lines.join('\n') ?? ''
    expect(corpo).toContain('7 alertas ao mesmo tempo')
    expect(corpo).toContain('e mais 2')
  })
})

describe('MOD-ADMIN-06 — apagar', () => {
  /** AC-03: alerta que só acende treina a equipe a ignorar painel. */
  it('AC-03: a condição precisa deixar de valer em duas avaliações', async () => {
    const tenant = await seedTenant('petshop-resolve')
    await givenMensagemPresa(tenant.tenantId)

    await evaluateAlerts()
    await evaluateAlerts()
    expect((await alertas())[0]?.status).toBe('FIRING')

    await ownerPrisma.message.deleteMany({ where: { tenantId: tenant.tenantId } })

    await evaluateAlerts()
    expect((await alertas())[0]?.status).toBe('FIRING')
    expect(enviados).toHaveLength(1)

    await evaluateAlerts()
    const resolvido = (await alertas())[0]
    expect(resolvido?.status).toBe('RESOLVED')
    expect(resolvido?.resolvedAt).not.toBeNull()
    expect(enviados).toHaveLength(2)
    expect(enviados[1]?.mail.subject).toContain('Resolvido')
  })

  /**
   * O que nunca acendeu some sem deixar rastro: o §6 do PRD é explícito — condição que
   * não vale, nada acontece. Guardar como resolvido um incidente que não existiu encheria
   * o histórico de fantasmas.
   */
  it('pendente que passa some da tabela, sem virar histórico', async () => {
    const tenant = await seedTenant('petshop-pico')
    await givenMensagemPresa(tenant.tenantId)

    await evaluateAlerts()
    expect(await alertas()).toHaveLength(1)

    await ownerPrisma.message.deleteMany({ where: { tenantId: tenant.tenantId } })
    await evaluateAlerts()

    expect(await alertas()).toHaveLength(0)
    expect(enviados).toHaveLength(0)
  })

  it('a condição que volta depois de resolvida abre um alerta novo', async () => {
    const tenant = await seedTenant('petshop-recorrente')
    await givenMensagemPresa(tenant.tenantId)
    await evaluateAlerts()
    await evaluateAlerts()

    await ownerPrisma.message.deleteMany({ where: { tenantId: tenant.tenantId } })
    await evaluateAlerts()
    await evaluateAlerts()

    await givenMensagemPresa(tenant.tenantId)
    await evaluateAlerts()

    const linhas = await alertas()
    expect(linhas).toHaveLength(2)
    expect(linhas[0]?.status).toBe('RESOLVED')
    expect(linhas[1]?.status).toBe('PENDING')
  })
})

describe('MOD-ADMIN-06 — a rota', () => {
  it('lista os alertas com o nome do estabelecimento e a frase da regra', async () => {
    const tenant = await seedTenant('petshop-painel')
    await givenMensagemPresa(tenant.tenantId)
    await evaluateAlerts()
    await evaluateAlerts()

    const response = await callPlatform({ url: '/platform/v1/alerts', user: admin })

    expect(response.statusCode).toBe(200)
    const [linha] = response.json().items
    expect(linha).toMatchObject({
      rule: 'message_queue_stuck',
      ruleLabel: 'Mensagens presas na fila de saída',
      status: 'FIRING',
      value: 1,
    })
    expect(linha.tenant).toMatchObject({ slug: 'petshop-painel' })
  })

  it('filtra por estado, e recusa estado inventado', async () => {
    const abertos = await callPlatform({ url: '/platform/v1/alerts?status=FIRING', user: admin })
    expect(abertos.statusCode).toBe(200)

    const invalido = await callPlatform({ url: '/platform/v1/alerts?status=ACESO', user: admin })
    expect(invalido.statusCode).toBe(422)
    expect(invalido.json().detail).toContain('FIRING')
  })

  it('quem não é da plataforma recebe 404', async () => {
    const estranho = await givenUser('Dono de Petshop')
    const response = await callPlatform({ url: '/platform/v1/alerts', user: estranho })
    expect(response.statusCode).toBe(404)
  })
})
