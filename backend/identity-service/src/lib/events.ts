import { connect, type ChannelModel, type Channel } from 'amqplib'
import {
  EVENTS_DLX,
  EVENTS_EXCHANGE,
  type IdentityEventMap,
} from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Publicação de eventos de domínio (PRD identidade_tenancy_01 §8).
 *
 * Exchange topic `petshop.events`, com DLX `petshop.events.dlx`. Os consumidores são
 * de outros módulos; aqui só existe o lado publicador.
 *
 * Publicação é **best-effort e sempre pós-commit**: o evento sai depois que a
 * transação fechou, e uma falha do broker é registrada mas não desfaz a operação de
 * negócio. Perder um evento é aceitável; perder o tenant recém-criado não é.
 *
 * TODO(MOD-ADMIN): trocar por outbox transacional quando o consumo de eventos
 * passar a ter garantia de entrega exigida por SLA.
 */

let connection: ChannelModel | null = null
let channel: Channel | null = null
let connecting: Promise<void> | null = null

async function ensureChannel(): Promise<Channel | null> {
  if (loadEnv().DISABLE_EVENTS) return null
  if (channel) return channel

  connecting ??= (async () => {
    connection = await connect(loadEnv().RABBITMQ_URL)
    const ch = await connection.createChannel()
    await ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
    await ch.assertExchange(EVENTS_DLX, 'topic', { durable: true })
    connection.on('close', () => {
      channel = null
      connection = null
      connecting = null
    })
    channel = ch
  })()

  try {
    await connecting
  } catch (error) {
    connecting = null
    logger.error({ err: error }, 'Falha ao conectar no RabbitMQ')
    return null
  }
  return channel
}

export async function publishEvent<K extends keyof IdentityEventMap>(
  routingKey: K,
  payload: Omit<IdentityEventMap[K], 'timestamp'>,
): Promise<void> {
  const body = { ...payload, timestamp: new Date().toISOString() }

  try {
    const ch = await ensureChannel()
    if (!ch) {
      logger.debug({ routingKey }, 'Publicação de evento desabilitada')
      return
    }
    ch.publish(EVENTS_EXCHANGE, routingKey, Buffer.from(JSON.stringify(body)), {
      contentType: 'application/json',
      persistent: true,
      timestamp: Date.now(),
    })
    logger.debug({ routingKey }, 'Evento publicado')
  } catch (error) {
    // Não propaga: a operação de negócio já foi comitada.
    logger.error({ err: error, routingKey, payload: body }, 'Falha ao publicar evento')
  }
}

export async function closeEvents(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
  connecting = null
}
