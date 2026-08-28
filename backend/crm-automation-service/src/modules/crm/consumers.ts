import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'
import { loadAppointmentVariables } from './appointment-vars.js'
import { resolveAutomation } from './automations.js'
import { getMessagingPort } from './messaging-port.js'

/**
 * O que a agenda e o prontuário contam ao relacionamento (§8).
 *
 * A divisão entre o que é evento e o que é varredura é deliberada e vale ler junto com
 * `reminders.ts`:
 *
 * - **Reação imediata é evento.** A confirmação precisa sair enquanto o cliente ainda
 *   está no balcão; uma varredura de hora em hora chegaria tarde demais para servir de
 *   confirmação. Se o evento se perder, a confirmação não sai — e essa perda é
 *   tolerável, porque o lembrete de D-1 ainda cobre o cliente.
 * - **Compromisso futuro é varredura.** O lembrete não pode depender de um publish
 *   best-effort, e por isso ele **não** está aqui.
 *
 * O cancelamento aparece nos dois papéis: cancela o lembrete pendente (para não mandar
 * "seu banho é amanhã" de um horário que não existe) e, se a automação estiver ligada,
 * avisa o tutor.
 */

const QUEUE = 'crm-automation-service.events'

const AgendamentoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
})

const AtendimentoConcluidoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid().optional(),
})

const TutorAnonimizadoSchema = z.object({
  tenantId: z.uuid(),
  tutorId: z.uuid(),
})

/** Confirmação do horário recém-marcado. */
export async function handleAgendamentoCriado(payload: unknown): Promise<void> {
  const event = AgendamentoSchema.parse(payload)
  await notifyAppointment(event.tenantId, event.appointmentId, 'appointment_confirmed')
}

/**
 * Cancelamento: mata o lembrete pendente **antes** de considerar o aviso.
 *
 * A ordem importa. Se o aviso falhasse e interrompesse o handler, o lembrete
 * continuaria na fila — e o cliente receberia, na manhã seguinte, um lembrete de um
 * horário cancelado. Cancelar primeiro é o que garante que a pior das duas falhas não
 * aconteça.
 */
export async function handleAgendamentoCancelado(payload: unknown): Promise<void> {
  const event = AgendamentoSchema.parse(payload)
  await cancelPending(event.tenantId, event.appointmentId)
  await notifyAppointment(event.tenantId, event.appointmentId, 'appointment_cancelled')
}

/**
 * Reagendamento: o lembrete antigo morre e nenhum aviso é mandado.
 *
 * O agendamento remarcado é um registro novo (RN-16 do MOD-AGENDA), e o
 * `agendamento.criado` dele já dispara a confirmação — mandar também um "cancelado"
 * faria o tutor receber duas mensagens contraditórias em segundos.
 */
export async function handleAgendamentoReagendado(payload: unknown): Promise<void> {
  const event = AgendamentoSchema.parse(payload)
  await cancelPending(event.tenantId, event.appointmentId)
}

/** "Seu pet está pronto" — nasce desligada (ver `automations.ts`). */
export async function handleAtendimentoConcluido(payload: unknown): Promise<void> {
  const event = AtendimentoConcluidoSchema.parse(payload)
  if (!event.appointmentId) return
  await notifyAppointment(event.tenantId, event.appointmentId, 'service_done')
}

/**
 * RN-10: o direito ao esquecimento alcança a fila.
 *
 * Cancelar o que ainda não saiu é a parte que **este** serviço pode fazer; apagar o
 * corpo do que já saiu é do messaging-service, que consome o mesmo evento.
 */
export async function handleTutorAnonimizado(payload: unknown): Promise<void> {
  const event = TutorAnonimizadoSchema.parse(payload)
  const { count } = await withTenant(event.tenantId, (tx) =>
    tx.message.updateMany({
      where: { tutorId: event.tutorId, status: { in: ['QUEUED', 'SCHEDULED'] } },
      data: { status: 'CANCELLED' },
    }),
  )
  if (count > 0) {
    logger.info({ cancelled: count }, 'mensagens pendentes canceladas por anonimização')
  }
}

async function cancelPending(tenantId: string, appointmentId: string): Promise<void> {
  const { count } = await withTenant(tenantId, (tx) =>
    tx.message.updateMany({
      where: {
        originType: 'APPOINTMENT',
        originId: appointmentId,
        status: { in: ['QUEUED', 'SCHEDULED'] },
      },
      data: { status: 'CANCELLED' },
    }),
  )
  if (count > 0) {
    logger.info({ appointmentId, cancelled: count }, 'mensagens pendentes canceladas')
  }
}

async function notifyAppointment(
  tenantId: string,
  appointmentId: string,
  key: 'appointment_confirmed' | 'appointment_cancelled' | 'service_done',
): Promise<void> {
  const automation = await withTenant(tenantId, (tx) => resolveAutomation(tx, key))
  if (!automation.enabled) return

  const context = await withTenant(tenantId, (tx) =>
    loadAppointmentVariables(tx, appointmentId),
  )
  if (!context) return

  await getMessagingPort().enqueue({
    tenantId,
    tutorId: context.tutorId,
    petId: context.petId,
    templateKey: automation.templateKey,
    channel: automation.channel,
    dedupeKey: `${key}:${appointmentId}`,
    originType: 'APPOINTMENT',
    originId: appointmentId,
    variables: context.variables,
  })
}

// ─── Fiação ──────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'agendamento.criado': handleAgendamentoCriado,
  'agendamento.cancelado': handleAgendamentoCancelado,
  'agendamento.reagendado': handleAgendamentoReagendado,
  'atendimento.concluido': handleAtendimentoConcluido,
  'tutor.anonimizado': handleTutorAnonimizado,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startCrmConsumers(): Promise<void> {
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

    // Um por vez: a ordem entre "criou" e "cancelou" do mesmo agendamento decide se o
    // tutor recebe uma confirmação de um horário que já não existe.
    await channel.prefetch(1)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE }, 'consumidores de evento no ar')
  } catch (error) {
    // Não derruba o serviço: a API de automações continua de pé sem o broker, e o
    // lembrete — que é varredura — continua saindo.
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

export async function stopCrmConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
