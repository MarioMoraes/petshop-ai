import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { loadAppointmentVariables } from './appointment-vars.js'
import { loadTaxiVariables } from './taxi-vars.js'
import { resolveAutomation } from './automations.js'
import { getMessagingPort } from './messaging-port.js'
import {
  handleConviteAceito,
  handleOnboardingConcluido,
  handlePrescricaoEmitida,
  handleReciboEmitido,
} from './notifications.js'

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

/**
 * **O nome da fila não acompanhou a consolidação**, como nos módulos anteriores: é
 * fila durável que já existe no RabbitMQ de cada instalação, com as ligações feitas.
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

/**
 * Os eventos de corrida (MOD-CRM-09).
 *
 * `notify` vem do MOD-TAXI e é o que decide se o tutor deve saber — quem publicou já
 * sabia o que o de cá não sabe. O caso concreto é o AC-02 de MOD-TAXI-08: "coletei" na
 * perna de volta é o pet **saindo do salão**, e o tutor recebe o "entreguei" minutos
 * depois. Duas mensagens para o mesmo trajeto é o que faz o cliente silenciar o número.
 */
const TaxiCorridaSchema = z.object({
  tenantId: z.uuid(),
  rideId: z.uuid(),
  notify: z.boolean().optional(),
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

// ─── Taxi Dog (MOD-CRM-09) ───────────────────────────────────────────────────

/** "Saímos para buscar" — com a janela prometida (AC-01). */
export async function handleTaxiACaminho(payload: unknown): Promise<void> {
  await notifyRide(payload, 'taxi_en_route')
}

/** "Chegamos e estamos na porta". */
export async function handleTaxiChegou(payload: unknown): Promise<void> {
  await notifyRide(payload, 'taxi_arrived')
}

/**
 * "O pet chegou em casa" (AC-02).
 *
 * Costuma cair no mesmo minuto que o `atendimento.concluido`, e é o caso que a RN-08
 * nomeia. O agrupamento **não** acontece aqui: quem consolida as duas numa só é o
 * messaging-service, no enfileiramento, porque é o único lugar que enxerga as duas
 * origens. Daqui saem dois pedidos, e é assim que deve ser.
 */
export async function handleTaxiEntregue(payload: unknown): Promise<void> {
  await notifyRide(payload, 'taxi_delivered')
}

/** Coleta frustrada (AC-03). O motivo sai em português, nunca o enum. */
export async function handleTaxiFalhou(payload: unknown): Promise<void> {
  await notifyRide(payload, 'taxi_failed')
}

async function notifyRide(
  payload: unknown,
  key: 'taxi_en_route' | 'taxi_arrived' | 'taxi_delivered' | 'taxi_failed',
): Promise<void> {
  const event = TaxiCorridaSchema.parse(payload)
  if (event.notify === false) return

  const automation = await withTenant(event.tenantId, (tx) => resolveAutomation(tx, key))
  if (!automation.enabled) return

  const context = await withTenant(event.tenantId, (tx) => loadTaxiVariables(tx, event.rideId))
  if (!context) return

  await getMessagingPort().enqueue({
    tenantId: event.tenantId,
    tutorId: context.tutorId,
    petId: context.petId,
    templateKey: automation.templateKey,
    channel: automation.channel,
    // Por corrida **e** por etapa: a mesma corrida gera "a caminho", "chegamos" e
    // "entregamos", e uma chave só por corrida faria as duas últimas serem descartadas
    // como duplicata.
    dedupeKey: `${key}:${event.rideId}`,
    originType: 'TAXI_RIDE',
    originId: event.rideId,
    variables: context.variables,
  })
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
  'taxi.a_caminho': handleTaxiACaminho,
  'taxi.chegou': handleTaxiChegou,
  'taxi.entregue': handleTaxiEntregue,
  'taxi.falhou': handleTaxiFalhou,

  /**
   * Os avisos do produto (MOD-NOTIF-06 a 09), em `notifications.ts`.
   *
   * Entram na mesma fila e no mesmo `prefetch(1)` dos demais, e é o que se quer: o
   * `recibo.emitido` de um tenant não pode passar na frente do `agendamento.cancelado`
   * de outro só por ser de outro módulo.
   */
  'recibo.emitido': handleReciboEmitido,
  'prescricao.emitida': handlePrescricaoEmitida,
  'tenant.onboarding.concluido': handleOnboardingConcluido,
  'convite.aceito': handleConviteAceito,
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
