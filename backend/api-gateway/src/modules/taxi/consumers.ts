import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE, type TaxiCancelReason } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { cancelRide } from './transitions.js'

/**
 * O que a agenda e o pet contam ao Taxi Dog (§8).
 *
 * O módulo publica muito e consome pouco, mas os quatro que consome são o que impede
 * a corrida de virar mentira:
 *
 * - **`atendimento.concluido`** destrava a volta (RN-10). Sem ele, o motorista sairia
 *   para buscar um pet que ainda está na secagem.
 * - **`agendamento.cancelado`** cancela em cascata (RN-14). Corrida órfã é pet
 *   esperando na calçada por um banho que não existe mais.
 * - **`agendamento.reagendado`** cancela também, mas **não move** a corrida (RN-15): o
 *   agendamento novo é outro registro, e a disponibilidade do motorista no dia novo é
 *   outra história. Quem confirma as janelas é a recepção.
 * - **`pet.obito`** cancela em silêncio (RN-21).
 *
 * **Idempotência** em todos os caminhos: o broker entrega ao menos uma vez, e um
 * segundo consumo do mesmo evento encontra a corrida já no estado final e sai calado.
 */

/**
 * **O nome da fila não acompanhou a consolidação**, como o do MOD-SITE: é uma fila
 * durável que já existe no RabbitMQ de cada instalação, com as ligações feitas.
 * Renomeá-la criaria uma segunda fila vazia e deixaria a primeira acumulando mensagem
 * que ninguém consome, sem erro nenhum no log.
 */
const QUEUE = 'taxidog-service.events'

const AtendimentoConcluidoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
})

const AgendamentoCanceladoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
})

const AgendamentoReagendadoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
})

const PetObitoSchema = z.object({
  tenantId: z.uuid(),
  petId: z.uuid(),
})

/** Status de onde ainda dá para cancelar. `ONBOARD` fica de fora (AC-06). */
const CANCELLABLE = ['REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED'] as const

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * RN-10: o pet ficou pronto — a volta pode sair.
 *
 * Só carimba `ready_at`; não muda status. A corrida continua `ASSIGNED` e é o
 * motorista quem decide quando sair, olhando a rota inteira. Promovê-la a `EN_ROUTE`
 * aqui seria o sistema dizendo que alguém está na rua quando ninguém saiu.
 */
export async function handleAtendimentoConcluido(payload: unknown): Promise<void> {
  const event = AtendimentoConcluidoSchema.parse(payload)

  await withTenant(event.tenantId, async (tx) => {
    const { count } = await tx.taxiRide.updateMany({
      where: {
        appointmentId: event.appointmentId,
        leg: 'DROPOFF',
        readyAt: null,
        status: { in: ['REQUESTED', 'ASSIGNED'] },
      },
      data: { readyAt: new Date() },
    })
    if (count > 0) {
      logger.info(
        { appointmentId: event.appointmentId, rides: count },
        'volta liberada pelo fim do atendimento',
      )
    }
  })
}

/** Cancela em cascata todas as corridas vivas de um agendamento. */
async function cascadeCancel(
  tenantId: string,
  where: { appointmentId?: string; petId?: string },
  reason: TaxiCancelReason,
): Promise<number> {
  const rides = await withTenant(tenantId, (tx) =>
    tx.taxiRide.findMany({
      where: {
        ...(where.appointmentId ? { appointmentId: where.appointmentId } : {}),
        ...(where.petId ? { petId: where.petId } : {}),
        status: { in: [...CANCELLABLE] },
        // Óbito e cancelamento olham só para o futuro: uma corrida de ontem que já
        // aconteceu não se desfaz por um evento de hoje.
        ...(where.petId ? { windowStartsAt: { gt: new Date() } } : {}),
      },
      select: { id: true },
    }),
  )

  let cancelled = 0
  for (const ride of rides) {
    try {
      // Sem `actorUserId`: quem cancelou foi o sistema, e a trilha precisa dizer isso
      // em vez de atribuir a ação a quem por acaso cancelou o agendamento.
      await cancelRide({ tenantId }, ride.id, { reason })
      cancelled += 1
    } catch (error) {
      // Uma corrida que não pôde ser cancelada não pode derrubar as outras.
      logger.error({ err: error, rideId: ride.id }, 'falha ao cancelar corrida em cascata')
    }
  }
  return cancelled
}

/** RN-14: agendamento cancelado, corridas canceladas. */
export async function handleAgendamentoCancelado(payload: unknown): Promise<void> {
  const event = AgendamentoCanceladoSchema.parse(payload)
  const cancelled = await cascadeCancel(
    event.tenantId,
    { appointmentId: event.appointmentId },
    'APPOINTMENT_CANCELLED',
  )
  if (cancelled > 0) {
    logger.info({ appointmentId: event.appointmentId, cancelled }, 'corridas canceladas em cascata')
  }
}

/**
 * RN-15: remarcar **não** move a corrida.
 *
 * O agendamento remarcado é um registro novo (RN-16 do MOD-AGENDA), e mover as
 * janelas automaticamente assumiria que o motorista está livre no dia novo — o que
 * ninguém verificou. As corridas antigas morrem e a recepção recria, confirmando a
 * disponibilidade.
 */
export async function handleAgendamentoReagendado(payload: unknown): Promise<void> {
  const event = AgendamentoReagendadoSchema.parse(payload)
  await cascadeCancel(
    event.tenantId,
    { appointmentId: event.appointmentId },
    'APPOINTMENT_RESCHEDULED',
  )
}

/** RN-21: o óbito cancela as futuras, em silêncio. */
export async function handlePetObito(payload: unknown): Promise<void> {
  const event = PetObitoSchema.parse(payload)
  await cascadeCancel(event.tenantId, { petId: event.petId }, 'PET_DECEASED')
}

// ─── Fiação ──────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'atendimento.concluido': handleAtendimentoConcluido,
  'agendamento.cancelado': handleAgendamentoCancelado,
  'agendamento.reagendado': handleAgendamentoReagendado,
  'pet.obito': handlePetObito,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startTaxiConsumers(): Promise<void> {
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

    // Um por vez: a ordem entre "concluiu" e "cancelou" do mesmo agendamento decide se
    // a volta é destravada ou cancelada.
    await channel.prefetch(1)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE }, 'consumidores de evento no ar')
  } catch (error) {
    // Não derruba o serviço: a API do Taxi Dog continua de pé sem o broker.
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

export async function stopTaxiConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
