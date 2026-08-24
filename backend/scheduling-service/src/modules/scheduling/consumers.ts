import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../env.js'
import { recordAudit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { OCCUPYING_STATUSES } from './conflicts.js'

/**
 * Eventos que a agenda **consome** (PRD agenda_operacao_06 §8, parágrafo final).
 *
 * Os três primeiros existem porque o ciclo de vida do pet e do tutor não pode deixar
 * a agenda apontando para quem não existe mais. O caso que mais importa é o óbito:
 * um lembrete de banho para um pet que morreu é o pior defeito que este produto pode
 * ter, e é por isso que o RN-10 manda cancelar **e suprimir a notificação**.
 */

const QUEUE = 'scheduling-service.events'

const PetObitoSchema = z.object({
  tenantId: z.uuid(),
  petId: z.uuid(),
})

const PetTransferidoSchema = z.object({
  tenantId: z.uuid(),
  petId: z.uuid(),
  toTutorId: z.uuid(),
})

const TutorMescladoSchema = z.object({
  tenantId: z.uuid(),
  sourceId: z.uuid(),
  targetId: z.uuid(),
})

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * RN-10: o pet morreu. Os agendamentos futuros são cancelados **sem taxa**.
 *
 * `cancelled_late = false` mesmo quando o horário é daqui a uma hora: cobrar taxa de
 * cancelamento tardio pelo óbito de um animal seria o pior erro possível.
 *
 * O evento de cancelamento **não** é republicado, de propósito. Quem consome
 * `agendamento.cancelado` avisa o tutor, e o RN-10 é explícito em suprimir essa
 * notificação — a família acabou de perder o pet e não precisa de um WhatsApp
 * automático sobre o banho de quinta.
 */
export async function handlePetObito(payload: unknown): Promise<void> {
  const event = PetObitoSchema.parse(payload)

  await withTenant(event.tenantId, async (tx) => {
    const futuros = await tx.appointment.findMany({
      where: {
        petId: event.petId,
        startsAt: { gt: new Date() },
        status: { in: [...OCCUPYING_STATUSES] },
      },
      select: { id: true },
    })
    if (futuros.length === 0) return

    const ids = futuros.map((row) => row.id)
    await tx.appointment.updateMany({
      where: { id: { in: ids } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledLate: false },
    })

    for (const id of ids) {
      await tx.appointmentStatusLog.create({
        data: {
          tenantId: event.tenantId,
          appointmentId: id,
          fromStatus: 'CONFIRMED',
          toStatus: 'CANCELLED',
          reason: 'Óbito do pet registrado',
        },
      })
    }

    await recordAudit(tx, {
      tenantId: event.tenantId,
      action: 'appointment.cancelled_by_death',
      entity: 'pet',
      entityId: event.petId,
      after: { cancelled: ids.length, notificationSuppressed: true },
    })
  })

  logger.info(
    { petId: event.petId, tenantId: event.tenantId },
    'agendamentos futuros cancelados por óbito',
  )
}

/**
 * O pet mudou de dono. Os agendamentos futuros passam a apontar para o novo tutor.
 *
 * Sem isso, o débito do atendimento cairia na conta de quem não tem mais o animal —
 * e a cobrança chegaria a alguém que já se despediu dele.
 */
export async function handlePetTransferido(payload: unknown): Promise<void> {
  const event = PetTransferidoSchema.parse(payload)

  await withTenant(event.tenantId, (tx) =>
    tx.appointment.updateMany({
      where: {
        petId: event.petId,
        startsAt: { gt: new Date() },
        status: { in: [...OCCUPYING_STATUSES] },
      },
      data: { tutorId: event.toTutorId },
    }),
  )
}

/**
 * Dois cadastros viraram um. Os agendamentos da origem passam para o destino.
 *
 * Inclui os **passados**: o histórico do tutor unificado precisa mostrar tudo o que
 * aconteceu sob os dois cadastros, senão a mescla teria escondido metade da relação.
 */
export async function handleTutorMesclado(payload: unknown): Promise<void> {
  const event = TutorMescladoSchema.parse(payload)

  await withTenant(event.tenantId, (tx) =>
    tx.appointment.updateMany({
      where: { tutorId: event.sourceId },
      data: { tutorId: event.targetId },
    }),
  )
}

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'pet.obito': handlePetObito,
  'pet.transferido': handlePetTransferido,
  'tutor.mesclado': handleTutorMesclado,
}

// ─── Consumo ─────────────────────────────────────────────────────────────────

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startSchedulingConsumers(): Promise<void> {
  if (loadEnv().DISABLE_EVENTS) {
    logger.debug('consumo de eventos desabilitado')
    return
  }

  connection = await connect(loadEnv().RABBITMQ_URL)
  channel = await connection.createChannel()

  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
  await channel.assertExchange(EVENTS_DLX, 'topic', { durable: true })
  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: EVENTS_DLX,
  })

  for (const routingKey of Object.keys(HANDLERS)) {
    await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, routingKey)
  }

  await channel.consume(QUEUE, (message) => void handleMessage(message))
  logger.info({ queue: QUEUE, keys: Object.keys(HANDLERS) }, 'consumidores da agenda no ar')
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
    logger.error({ err: error, routingKey }, 'falha ao processar evento')
    // `requeue: false` manda para a DLX, que tem o backoff. Reenfileirar aqui
    // criaria um laço apertado contra um erro que não vai se resolver sozinho.
    channel.nack(message, false, false)
  }
}

export async function stopSchedulingConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
