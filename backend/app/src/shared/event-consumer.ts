import { connect, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { Prisma } from '@petshop/db'
import { AppError, EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../config/env.js'
import { logger, recordMetric } from './logger.js'

/**
 * O consumo de eventos do processo — um mecanismo só para as filas de todos os módulos.
 *
 * Eram oito cópias do mesmo bloco, uma por módulo, cada uma com a sua conexão AMQP, e
 * as oito tinham os mesmos dois defeitos:
 *
 * 1. **A falha descartava o evento.** O `nack` sem requeue mandava a mensagem para a
 *    `petshop.events.dlx` "que aplica o backoff" — e nenhuma fila estava ligada a ela.
 *    Um deadlock no `atendimento.concluido` era um débito que nunca entrava no extrato,
 *    sem nada no banco que acusasse a falta.
 * 2. **A conexão caída não voltava.** Sem handler de `close`, um restart do broker
 *    deixava o processo de pé e surdo até o próximo deploy.
 *
 * O que cada módulo declara é o **quê** (`ConsumerSpec`: fila, handlers, prefetch); o
 * **como** mora aqui. Os nomes de fila e os argumentos do `assertQueue` são os de sempre:
 * fila é identidade no broker, e um argumento diferente na declaração derruba o canal com
 * `PRECONDITION_FAILED`.
 */

export type EventHandler = (payload: unknown) => Promise<unknown>

export interface ConsumerSpec {
  queue: string
  /** Como o log chama este consumidor ("financeiro", "agenda"). */
  label: string
  handlers: Record<string, EventHandler>
  /** Ausente = sem limite, como a agenda sempre consumiu. */
  prefetch?: number
  /**
   * O erro que significa "isto já foi feito" — a reentrega que esbarrou na chave de
   * idempotência. Conta como sucesso: o evento sai da fila sem ir ao estacionamento.
   */
  isAlreadyApplied?: (error: unknown) => boolean
}

/**
 * Onde o evento que não pôde ser processado espera por alguém.
 *
 * Ligada à DLX com `#`, recebe o que vier de qualquer fila; o header `x-death` diz de
 * qual. O teto existe porque estacionamento sem leitor é disco crescendo: quatorze dias
 * dão tempo de ler o alerta e reprocessar, e cem mil mensagens é muito acima de qualquer
 * incidente que a operação comporte sem ter percebido.
 */
export const PARKING_QUEUE = 'petshop.events.dead'
const PARKING_TTL_MS = 14 * 24 * 60 * 60 * 1000
const PARKING_MAX_LENGTH = 100_000

/**
 * As esperas entre tentativas, com a mensagem **retida** — e não devolvida a uma fila de
 * retry.
 *
 * A diferença é a ordem. Com `prefetch(1)`, segurar a mensagem segura a fila, e o evento
 * seguinte só passa depois deste. Uma fila de retry o entregaria **depois** dos que
 * vieram em seguida: o `lancamento.criado` grava em `tutors.balance_cents` o saldo
 * absoluto que veio no evento, e um saldo velho chegando atrás de um novo deixaria o
 * espelho errado; um `agendamento.criado` atrás do `cancelado` mandaria a confirmação de
 * um horário que já não existe. Quinze segundos de fila parada contra um banco que
 * engasgou é o preço — ela pararia de qualquer jeito.
 */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const

/**
 * Os erros do Prisma que passam sozinhos: conexão, tempo esgotado e conflito entre
 * transações. Qualquer outro código conhecido é o dado dizendo não, e repetir não muda
 * a resposta.
 */
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'])

/**
 * Erro permanente vai direto ao estacionamento; o resto é repetido.
 *
 * Repetir é seguro porque cada handler grava numa transação só, e o que ele faz depois
 * do commit — invalidar cache, publicar — engole a própria falha. O handler que lança,
 * então, lança com a transação desfeita.
 */
export function isPermanentError(error: unknown): boolean {
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof AppError) {
    return true
  }
  if (error instanceof Prisma.PrismaClientValidationError) return true
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return !TRANSIENT_PRISMA_CODES.has(error.code)
  }
  return false
}

/** O pedaço do canal que o processamento usa — é o que o teste dubla. */
export interface MessageSettler {
  ack(message: ConsumeMessage): void
  /** Sem requeue: a mensagem vai à DLX, e dela ao estacionamento. */
  park(message: ConsumeMessage): void
}

export interface ProcessOptions {
  sleep: (ms: number) => Promise<void>
  /** O processo está encerrando, ou o canal caiu: a mensagem volta ao broker sozinha. */
  isAbandoned: () => boolean
}

export type ProcessOutcome = 'acked' | 'parked' | 'abandoned'

export async function processMessage(
  spec: ConsumerSpec,
  settler: MessageSettler,
  message: ConsumeMessage,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  const routingKey = message.fields.routingKey
  const handler = spec.handlers[routingKey]
  if (!handler) {
    settler.ack(message)
    return 'acked'
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      await handler(JSON.parse(message.content.toString()))
      settler.ack(message)
      return 'acked'
    } catch (error) {
      if (spec.isAlreadyApplied?.(error)) {
        settler.ack(message)
        return 'acked'
      }

      const delay = RETRY_DELAYS_MS[attempt - 1]
      if (isPermanentError(error) || delay === undefined) {
        logger.error(
          { err: error, queue: spec.queue, routingKey, attempt },
          'evento estacionado: o handler falhou e não vai ser repetido',
        )
        recordMetric({ metric: 'event_parked_total', value: 1, unit: 'count' })
        settler.park(message)
        return 'parked'
      }

      logger.warn(
        { err: error, queue: spec.queue, routingKey, attempt, retryInMs: delay },
        'falha transitória ao processar evento: tentando de novo',
      )
      await options.sleep(delay)
      // Sem ack nem nack: o canal que cai devolve ao broker o que não foi confirmado, e
      // outro processo — ou este, depois de reconectar — recebe a mensagem de novo.
      if (options.isAbandoned()) return 'abandoned'
    }
  }
}

// ─── A conexão ───────────────────────────────────────────────────────────────

const RECONNECT_MAX_DELAY_MS = 30_000
const CHANNEL_REOPEN_DELAY_MS = 1_000

let connection: ChannelModel | null = null
let stopping = false
let reconnectAttempt = 0
let reconnectTimer: NodeJS.Timeout | null = null
/** As esperas em curso, para o encerramento não ficar preso atrás de um backoff. */
const pendingSleeps = new Set<() => void>()

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(wake, ms)
    function wake() {
      clearTimeout(timer)
      pendingSleeps.delete(wake)
      resolve()
    }
    pendingSleeps.add(wake)
  })
}

/**
 * Liga os consumidores. **Nunca lança**: com o broker fora, o backend sobe sem eles e
 * tenta de novo com backoff — a API não depende de evento para responder, e um processo
 * que morre no boot por causa do RabbitMQ derrubaria o Admin junto.
 */
export async function startEventConsumers(specs: readonly ConsumerSpec[]): Promise<void> {
  if (loadEnv().DISABLE_EVENTS) {
    logger.debug('consumo de eventos desabilitado')
    return
  }
  stopping = false
  await connectAll(specs)
}

export async function stopEventConsumers(): Promise<void> {
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  for (const wake of [...pendingSleeps]) wake()

  const current = connection
  connection = null
  try {
    await current?.close()
  } catch {
    // Encerramento best-effort.
  }
}

async function connectAll(specs: readonly ConsumerSpec[]): Promise<void> {
  let current: ChannelModel | null = null
  try {
    current = await connect(loadEnv().RABBITMQ_URL)
    const opened = current
    connection = opened

    opened.on('error', (error: unknown) => {
      logger.warn({ err: error }, 'erro na conexão dos consumidores de evento')
    })
    opened.on('close', () => {
      // Só a conexão vigente reage: a que este módulo mesmo fechou já foi trocada.
      if (connection !== opened) return
      connection = null
      if (!stopping) {
        logger.warn('conexão dos consumidores de evento caiu: reconectando')
        scheduleReconnect(specs)
      }
    })

    await declareParking(opened)
    for (const spec of specs) await openConsumer(opened, spec)

    reconnectAttempt = 0
  } catch (error) {
    logger.error({ err: error }, 'falha ao ligar os consumidores de evento')
    if (connection === current) connection = null
    await current?.close().catch(() => undefined)
    if (!stopping) scheduleReconnect(specs)
  }
}

function scheduleReconnect(specs: readonly ConsumerSpec[]): void {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * 2 ** reconnectAttempt)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!stopping) void connectAll(specs)
  }, delay)
  reconnectTimer.unref()
}

async function declareParking(current: ChannelModel): Promise<void> {
  const channel = await current.createChannel()
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
  await channel.assertExchange(EVENTS_DLX, 'topic', { durable: true })
  await channel.assertQueue(PARKING_QUEUE, {
    durable: true,
    messageTtl: PARKING_TTL_MS,
    maxLength: PARKING_MAX_LENGTH,
  })
  await channel.bindQueue(PARKING_QUEUE, EVENTS_DLX, '#')
  await channel.close()
}

/**
 * Um canal por fila, para o `prefetch` de cada uma valer só para ela.
 *
 * O canal pode cair sozinho, com a conexão de pé — um `ack` duplicado é o bastante —, e
 * sem reabri-lo aquela fila pararia calada enquanto as outras seguem. Daí o `close`
 * próprio, que só age enquanto a conexão dele for a vigente.
 */
async function openConsumer(current: ChannelModel, spec: ConsumerSpec): Promise<void> {
  const channel = await current.createChannel()
  let open = true

  channel.on('error', (error: unknown) => {
    logger.warn({ err: error, queue: spec.queue }, 'erro no canal de consumo')
  })
  channel.on('close', () => {
    open = false
    if (stopping || connection !== current) return
    setTimeout(() => {
      if (stopping || connection !== current) return
      logger.warn({ queue: spec.queue }, 'canal de consumo caiu: reabrindo')
      openConsumer(current, spec).catch((error: unknown) => {
        logger.error({ err: error, queue: spec.queue }, 'falha ao reabrir o canal de consumo')
      })
    }, CHANNEL_REOPEN_DELAY_MS).unref()
  })

  await channel.assertQueue(spec.queue, { durable: true, deadLetterExchange: EVENTS_DLX })
  for (const routingKey of Object.keys(spec.handlers)) {
    await channel.bindQueue(spec.queue, EVENTS_EXCHANGE, routingKey)
  }
  if (spec.prefetch !== undefined) await channel.prefetch(spec.prefetch)

  // `ack`/`nack` num canal fechado — ou fechando — lançam; a mensagem já voltou ao broker
  // nesse caso, e não há o que confirmar.
  const settle = (action: () => void) => {
    if (!open) return
    try {
      action()
    } catch (error) {
      logger.warn({ err: error, queue: spec.queue }, 'confirmação perdida: o canal fechou')
    }
  }
  const settler: MessageSettler = {
    ack: (message) => settle(() => channel.ack(message)),
    park: (message) => settle(() => channel.nack(message, false, false)),
  }
  const options: ProcessOptions = {
    sleep: interruptibleSleep,
    isAbandoned: () => stopping || !open,
  }

  await channel.consume(spec.queue, (message) => {
    if (message) void processMessage(spec, settler, message, options)
  })
  logger.info(
    { consumer: spec.label, queue: spec.queue, keys: Object.keys(spec.handlers) },
    'consumidores de evento no ar',
  )
}
