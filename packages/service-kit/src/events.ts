import { connect, type Channel, type ChannelModel } from 'amqplib'
import { EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import type { Logger } from 'pino'

/**
 * Publicação de eventos de domínio (PRDs §8).
 *
 * Exchange topic `petshop.events`, com DLX `petshop.events.dlx`. Aqui só existe o
 * lado publicador; quem consome são outros módulos.
 *
 * Publicação é **best-effort e sempre pós-commit**: o evento sai depois que a
 * transação fechou, e uma falha do broker é registrada mas não desfaz a operação de
 * negócio. Perder um evento é aceitável; perder o cadastro que o originou não é.
 *
 * TODO(MOD-ADMIN): trocar por outbox transacional quando o consumo de eventos passar
 * a ter garantia de entrega exigida por SLA. O ponto único de troca é aqui — foi
 * metade da razão para extrair o pacote.
 */

/** Todo evento carrega o instante em que aconteceu; o publicador é quem o carimba. */
interface TimestampedEvent {
  timestamp: string
}

/**
 * Restrição do mapa de eventos, escrita como `Record<keyof M, …>` e não
 * `Record<string, …>` de propósito: os mapas de `@petshop/shared-types` são
 * `interface`, e interface não ganha index signature implícita — a forma com
 * `keyof` compara chave a chave e aceita as duas declarações.
 */
export type EventMapOf<M> = Record<keyof M, TimestampedEvent>

export interface PublisherConfig {
  logger: Logger
  /** Lidos a cada chamada: `loadEnv()` é memoizado sob demanda e resetado em teste. */
  getUrl: () => string
  isDisabled: () => boolean
}

/** O que o painel de saúde pergunta ao broker (MOD-ADMIN-04). */
export interface EventsHealth {
  state: 'UP' | 'DOWN' | 'DISABLED'
  error?: string
}

export interface EventPublisher<EventMap extends EventMapOf<EventMap>> {
  publishEvent: <K extends keyof EventMap & string>(
    routingKey: K,
    payload: Omit<EventMap[K], 'timestamp'>,
  ) => Promise<void>
  closeEvents: () => Promise<void>
  /**
   * O broker responde?
   *
   * **Reusa o canal do publicador em vez de abrir um só para perguntar.** Uma conexão
   * nova a cada abertura do painel de saúde criaria e derrubaria conexão AMQP em cadência
   * de tela — e um painel que pesa no que observa é o primeiro a ser desligado.
   */
  checkEvents: () => Promise<EventsHealth>
}

/**
 * O mapa de eventos é o parâmetro de tipo: cada serviço instancia com o seu
 * (`TutorEventMap`, `PetEventMap`, …) e ganha routing key e payload conferidos pelo
 * compilador, sem que o pacote conheça um único evento de negócio.
 */
export function createEventPublisher<EventMap extends EventMapOf<EventMap>>(
  config: PublisherConfig,
): EventPublisher<EventMap> {
  const { logger } = config

  let connection: ChannelModel | null = null
  let channel: Channel | null = null
  let connecting: Promise<void> | null = null
  /** A última falha de conexão, para o painel de saúde poder dizer qual foi. */
  let lastError: string | null = null

  async function ensureChannel(): Promise<Channel | null> {
    if (config.isDisabled()) return null
    if (channel) return channel

    connecting ??= (async () => {
      connection = await connect(config.getUrl())
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
      lastError = error instanceof Error ? error.message : String(error)
      logger.error({ err: error }, 'Falha ao conectar no RabbitMQ')
      return null
    }
    lastError = null
    return channel
  }

  return {
    async publishEvent<K extends keyof EventMap & string>(
      routingKey: K,
      payload: Omit<EventMap[K], 'timestamp'>,
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
        // Não propaga: a operação de negócio já foi comitada. E o payload fica fora
        // do log de propósito — vários eventos carregam PII (`tutor.criado` leva o
        // telefone), e uma falha de broker não é motivo para gravá-la em disco.
        logger.error({ err: error, routingKey }, 'Falha ao publicar evento')
      }
    },

    async checkEvents(): Promise<EventsHealth> {
      if (config.isDisabled()) return { state: 'DISABLED' }
      const ch = await ensureChannel()
      if (ch) return { state: 'UP' }
      return { state: 'DOWN', ...(lastError ? { error: lastError } : {}) }
    },

    async closeEvents(): Promise<void> {
      try {
        await channel?.close()
        await connection?.close()
      } catch {
        // Encerramento best-effort.
      }
      channel = null
      connection = null
      connecting = null
    },
  }
}
