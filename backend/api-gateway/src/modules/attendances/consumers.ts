import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant, type TenantTransaction } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE, type AttendanceType } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../config/env.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { invalidateSummary } from './cache.js'
import { addHours, EDIT_WINDOW_HOURS } from './service.js'

/**
 * De onde vem o atendimento (PRD prontuario_04 §8, parágrafo final).
 *
 * O prontuário **não tem POST de criação** no caminho normal: o registro clínico é
 * consequência do pet ter passado pelo salão, e quem sabe disso é a agenda. Ela
 * publica `atendimento.iniciado` no check-in e `atendimento.concluido` no check-out;
 * aqui os dois viram uma linha em `attendances` — rascunho e depois fechada.
 *
 * É o mesmo contrato assíncrono pelo qual o MOD-LEDGER lança o débito do mesmo
 * evento. Se o dinheiro pode nascer assim, o registro do serviço também pode.
 *
 * **Idempotência** em todos os caminhos: o broker entrega ao menos uma vez, e o
 * índice único parcial de `appointment_id` é a rede embaixo — dois consumos do mesmo
 * check-out não podem virar dois atendimentos, nem duas cobranças de nada.
 */

/**
 * **O nome da fila não acompanhou a migração, e isso é regra.**
 *
 * É uma fila durável que já existe no RabbitMQ de cada instalação, com as ligações
 * feitas. Renomeá-la criaria uma segunda fila vazia e deixaria a primeira acumulando
 * mensagem que ninguém mais consome — e o sintoma seria atendimento parando de nascer
 * do check-out, sem erro nenhum no log. Vale para o nome do lease dos jobs e para as
 * chaves de cache pela mesma razão: são identidade em infraestrutura, não rótulo.
 */
const QUEUE = 'medical-record-service.events'

const AtendimentoIniciadoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
  petId: z.uuid(),
  professionalId: z.uuid(),
})

const AtendimentoConcluidoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
  petId: z.uuid(),
  tutorId: z.uuid(),
  professionalId: z.uuid(),
  items: z.array(
    z.object({
      serviceId: z.uuid(),
      label: z.string(),
      priceCents: z.number().int(),
    }),
  ),
  totalCents: z.number().int(),
  weightKg: z.number().positive().nullable().optional(),
  origin: z.enum(['SCHEDULED', 'WALK_IN']).optional(),
  startedAt: z.iso.datetime().optional(),
})

const PetObitoSchema = z.object({
  tenantId: z.uuid(),
  petId: z.uuid(),
})

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * Check-in: abre o rascunho.
 *
 * O rascunho existe para MOD-PRONT-10 — é onde o banhista anota o que viu enquanto
 * o pet está com ele. Sem ele, a observação só teria lugar depois do check-out, que
 * é exatamente quando o cliente está na frente esperando para ir embora.
 *
 * O tipo sai do primeiro item do agendamento, e a `tutor_id` é fotografada agora
 * (RN-14): quem respondia pelo pet no dia continua sendo quem respondia, mesmo que
 * a titularidade mude depois.
 */
export async function handleAtendimentoIniciado(payload: unknown): Promise<void> {
  const event = AtendimentoIniciadoSchema.parse(payload)

  await withTenant(event.tenantId, async (tx) => {
    const existing = await tx.attendance.findFirst({
      where: { appointmentId: event.appointmentId, status: { not: 'VOIDED' } },
      select: { id: true },
    })
    if (existing) return

    const appointment = await tx.appointment.findFirst({
      where: { id: event.appointmentId },
      select: {
        id: true,
        petId: true,
        tutorId: true,
        startsAt: true,
        checkinAt: true,
        source: true,
        items: { select: { serviceId: true }, take: 1 },
      },
    })
    // O agendamento pode ter sido cancelado entre o check-in e a entrega do evento.
    if (!appointment) return

    await tx.attendance.create({
      data: {
        tenantId: event.tenantId,
        petId: appointment.petId,
        tutorId: appointment.tutorId,
        appointmentId: appointment.id,
        type: await inferType(tx, appointment.items[0]?.serviceId),
        origin: appointment.source === 'WALK_IN' ? 'WALK_IN' : 'SCHEDULED',
        performedBy: event.professionalId,
        startedAt: appointment.checkinAt ?? appointment.startsAt,
        status: 'DRAFT',
      },
    })
  })
}

/**
 * Check-out: fecha o registro.
 *
 * Copia os itens com o preço **já congelado** que o evento carrega — quem lança o
 * histórico não pode reconsultar o catálogo, que pode ter mudado de preço desde o
 * agendamento (RN-07). É a mesma razão pela qual o MOD-LEDGER debita a partir do
 * payload e não da tabela de preços.
 *
 * Cria direto em `COMPLETED` quando não achou rascunho: é o caso do encaixe, que
 * nasce concluído, e o da reentrega em que o `atendimento.iniciado` se perdeu.
 */
export async function handleAtendimentoConcluido(payload: unknown): Promise<void> {
  const event = AtendimentoConcluidoSchema.parse(payload)

  const petId = await withTenant(event.tenantId, async (tx) => {
    const existing = await tx.attendance.findFirst({
      where: { appointmentId: event.appointmentId, status: { not: 'VOIDED' } },
      select: { id: true, status: true },
    })
    // Já fechado: entrega repetida. Refazer os itens duplicaria o histórico.
    if (existing?.status === 'COMPLETED') return event.petId

    const finishedAt = new Date()
    const startedAt = event.startedAt ? new Date(event.startedAt) : finishedAt
    const items = event.items.map((item) => ({
      tenantId: event.tenantId,
      serviceId: item.serviceId,
      label: item.label,
      executedBy: event.professionalId,
      unitPriceCents: BigInt(item.priceCents),
      quantity: 1,
      totalPriceCents: BigInt(item.priceCents),
      productsUsed: [],
    }))

    const common = {
      status: 'COMPLETED' as const,
      finishedAt,
      editableUntil: addHours(finishedAt, EDIT_WINDOW_HOURS),
      totalCents: BigInt(event.totalCents),
      ...(event.weightKg == null ? {} : { weightKg: event.weightKg }),
    }

    if (existing) {
      await tx.attendance.update({
        where: { id: existing.id },
        data: { ...common, items: { create: items } },
      })
    } else {
      await tx.attendance.create({
        data: {
          ...common,
          tenantId: event.tenantId,
          petId: event.petId,
          tutorId: event.tutorId,
          appointmentId: event.appointmentId,
          type: await inferType(tx, event.items[0]?.serviceId),
          origin: event.origin === 'WALK_IN' ? 'WALK_IN' : 'SCHEDULED',
          performedBy: event.professionalId,
          startedAt,
          items: { create: items },
        },
      })
    }

    return event.petId
  })

  await invalidateSummary(event.tenantId, petId)
  recordMetric({
    metric: 'attendance_created_total',
    tenantId: event.tenantId,
    value: 1,
    unit: 'count',
  })
}

/**
 * O pet morreu: os alertas ativos são encerrados.
 *
 * Pendência herdada do MOD-AGENDA. Não é limpeza cosmética — um alerta de alergia
 * vivo num pet falecido continua aparecendo em toda tela operacional e treina a
 * equipe a ignorar alerta, que é o pior efeito colateral possível num módulo de
 * segurança.
 *
 * O histórico permanece: a desativação carrega motivo e data, como qualquer outra.
 */
export async function handlePetObito(payload: unknown): Promise<void> {
  const event = PetObitoSchema.parse(payload)
  const reason = 'Encerrado automaticamente pelo registro de óbito do pet'
  const now = new Date()

  await withTenant(event.tenantId, async (tx) => {
    await tx.allergy.updateMany({
      where: { petId: event.petId, active: true },
      data: { active: false, resolutionNotes: reason, deactivatedAt: now },
    })
    await tx.medicalAlert.updateMany({
      where: { petId: event.petId, active: true },
      data: { active: false, resolutionNotes: reason, deactivatedAt: now },
    })
  })

  await invalidateSummary(event.tenantId, event.petId)
}

/**
 * O tipo do atendimento sai da categoria do primeiro serviço.
 *
 * É inferência, e assumidamente grosseira: um atendimento com banho e consulta vira
 * "banho". A alternativa seria perguntar no check-out, e o §3 do PRD é explícito em
 * não acrescentar campo obrigatório ao balcão. Quem precisa do detalhe lê os itens,
 * que estão todos lá; o tipo é a lente do histórico, não a verdade do que aconteceu.
 */
async function inferType(
  tx: TenantTransaction,
  serviceId: string | undefined,
): Promise<AttendanceType> {
  if (!serviceId) return 'OTHER'
  const service = await tx.service.findFirst({
    where: { id: serviceId },
    select: { category: true },
  })
  switch (service?.category) {
    case 'BATH':
      return 'BATH'
    case 'GROOMING':
      return 'GROOMING'
    case 'VET':
      return 'VET_CONSULT'
    case 'VACCINE':
      return 'VACCINE'
    default:
      return 'OTHER'
  }
}

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'atendimento.iniciado': handleAtendimentoIniciado,
  'atendimento.concluido': handleAtendimentoConcluido,
  'pet.obito': handlePetObito,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startRecordConsumers(): Promise<void> {
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

    // Um por vez: a ordem entre o check-in e o check-out do mesmo agendamento é a
    // diferença entre fechar um rascunho e criar um segundo registro.
    await channel.prefetch(1)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE }, 'consumidores de evento no ar')
  } catch (error) {
    // Não derruba o serviço: a API do prontuário continua de pé sem o broker.
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

export async function stopRecordConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
