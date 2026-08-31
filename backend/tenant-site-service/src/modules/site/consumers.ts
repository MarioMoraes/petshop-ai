import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'
import { refreshSite } from './revalidate.js'

/**
 * O que o resto do sistema conta ao site (AC-03 de MOD-SITE-11).
 *
 * A página é montada de dados que **outros módulos** editam: o horário e o endereço
 * saem de `/configuracoes`, os serviços e os preços saem do catálogo da agenda. Sem
 * estes dois consumidores, o horário corrigido às 9h só apareceria ao meio-dia, pelo
 * TTL — e o AC-02 do MOD-SITE-06 ("o site reflete a mudança sem ninguém tocar no
 * site") viraria letra morta.
 *
 * **Invalida o host daquele tenant, e só ele.** Revalidar todos os sites porque um
 * petshop mudou o horário desperdiça render de todo mundo.
 *
 * Nota sobre o nome do evento do catálogo: o PRD §8 pede `servico.criado` /
 * `.atualizado` / `.removido` e diz que não existem. Existem, desde o MOD-AGENDA:
 * são um evento só, `agenda.servico.alterado`, com `action` no payload
 * (`scheduling-service/src/modules/catalog/service.ts`). Um evento com ação basta
 * aqui — a reação é a mesma para os três.
 */

const QUEUE = 'tenant-site-service.events'

const TenantScopedSchema = z.object({ tenantId: z.uuid() })

/**
 * O slug não vem do evento: `tenant.configuracao.atualizada` não o carrega, e inventar
 * um campo novo em um evento consumido por três serviços para poupar uma consulta
 * barata seria trocar acoplamento por microssegundos. `refreshSite` o resolve.
 */

export async function handleTenantSettingsChanged(payload: unknown): Promise<void> {
  const event = TenantScopedSchema.parse(payload)
  await refreshSite(event.tenantId)
}

export async function handleServiceChanged(payload: unknown): Promise<void> {
  const event = TenantScopedSchema.parse(payload)
  await refreshSite(event.tenantId)
}

// ─── Fiação ──────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'tenant.configuracao.atualizada': handleTenantSettingsChanged,
  'agenda.servico.alterado': handleServiceChanged,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startSiteConsumers(): Promise<void> {
  if (loadEnv().DISABLE_EVENTS) {
    logger.debug('consumo de eventos desabilitado')
    return
  }

  try {
    connection = await connect(loadEnv().RABBITMQ_URL)
    channel = await connection.createChannel()

    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
    await channel.assertExchange(EVENTS_DLX, 'topic', { durable: true })
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: EVENTS_DLX })
    for (const routingKey of Object.keys(HANDLERS)) {
      await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, routingKey)
    }

    await channel.prefetch(5)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE }, 'consumidores de evento no ar')
  } catch (error) {
    // Não derruba o serviço: a página continua sendo servida e se atualiza pelo TTL.
    logger.error({ err: error }, 'falha ao iniciar os consumidores de evento')
  }
}

async function handleMessage(message: ConsumeMessage | null): Promise<void> {
  if (!message || !channel) return

  const routingKey = message.fields.routingKey
  const handler = HANDLERS[routingKey]
  if (!handler) {
    channel.ack(message)
    return
  }

  try {
    await handler(JSON.parse(message.content.toString()))
    channel.ack(message)
  } catch (error) {
    // `requeue: false` manda para o DLX, que aplica o backoff exponencial do §8.
    logger.error({ err: error, routingKey }, 'falha ao processar evento')
    channel.nack(message, false, false)
  }
}

export async function stopSiteConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
