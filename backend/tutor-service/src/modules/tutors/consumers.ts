import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant, type TenantTransaction } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE, TUTOR_ROUTING_KEYS } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../env.js'
import { publishEvent } from '../../lib/events.js'
import { logger } from '../../lib/logger.js'
import { invalidateTutor } from '../../lib/redis.js'
import { setSystemTag } from '../tags/service.js'
import { recordConsentsIn } from '../consents/service.js'

/**
 * Eventos que o tutor-service **consome** (PRD tutores_02 §8, parágrafo final).
 *
 * Todos mantêm dado denormalizado que a listagem de balcão não pode calcular na hora
 * (RN-10): último atendimento, saldo, quantidade de pets e as tags automáticas que
 * derivam deles.
 *
 * Os publicadores de MOD-PRONT, MOD-LEDGER e MOD-CRM ainda não existem; os de
 * MOD-PET, sim. Os handlers existem e são testados — o que falta é quem emite.
 */

const QUEUE = 'tutor-service.events'

const AtendimentoConcluidoSchema = z.object({
  tenantId: z.uuid(),
  tutorId: z.uuid(),
  concludedAt: z.iso.datetime().optional(),
})

const LancamentoCriadoSchema = z.object({
  tenantId: z.uuid(),
  tutorId: z.uuid(),
  balanceCents: z.number().int(),
})

const PetCriadoSchema = z.object({
  tenantId: z.uuid(),
  primaryTutorId: z.uuid(),
})

const PetVinculoAlteradoSchema = z.object({
  tenantId: z.uuid(),
  tutorId: z.uuid(),
})

const MensagemRecebidaSchema = z.object({
  tenantId: z.uuid(),
  tutorId: z.uuid(),
  body: z.string(),
})

/** Palavras que valem como opt-out no WhatsApp brasileiro. */
const OPT_OUT_WORDS = new Set(['SAIR', 'PARAR', 'CANCELAR', 'DESCADASTRAR', 'STOP'])

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * RN-10 — `last_attendance_at` é escrito aqui, nunca calculado na listagem. Concluir
 * um atendimento também tira a tag INATIVO (AC-03 de MOD-TUTOR-05).
 */
export async function handleAtendimentoConcluido(payload: unknown): Promise<void> {
  const event = AtendimentoConcluidoSchema.parse(payload)
  const concludedAt = event.concludedAt ? new Date(event.concludedAt) : new Date()

  const removed = await withTenant(event.tenantId, async (tx) => {
    await tx.tutor.updateMany({
      where: { id: event.tutorId },
      data: { lastAttendanceAt: concludedAt },
    })
    return setSystemTag(tx, {
      tenantId: event.tenantId,
      tutorId: event.tutorId,
      key: 'INATIVO',
      applied: false,
    })
  })

  await invalidateTutor(event.tenantId, event.tutorId)
  if (removed) {
    await publishEvent(TUTOR_ROUTING_KEYS.tutorTagRemovida, {
      tenantId: event.tenantId,
      tutorId: event.tutorId,
      tagKey: 'INATIVO',
      automatic: true,
    })
  }
}

/**
 * RN-12 — a tag INADIMPLENTE segue o ledger e só o ledger. Saldo negativo aplica,
 * saldo quitado remove; ninguém marca à mão.
 */
export async function handleLancamentoCriado(payload: unknown): Promise<void> {
  const event = LancamentoCriadoSchema.parse(payload)
  const inDebt = event.balanceCents < 0

  const changed = await withTenant(event.tenantId, async (tx) => {
    await tx.tutor.updateMany({
      where: { id: event.tutorId },
      data: { balanceCents: event.balanceCents },
    })
    return setSystemTag(tx, {
      tenantId: event.tenantId,
      tutorId: event.tutorId,
      key: 'INADIMPLENTE',
      applied: inDebt,
    })
  })

  await invalidateTutor(event.tenantId, event.tutorId)
  if (changed) {
    await publishEvent(
      inDebt ? TUTOR_ROUTING_KEYS.tutorTagAplicada : TUTOR_ROUTING_KEYS.tutorTagRemovida,
      {
        tenantId: event.tenantId,
        tutorId: event.tutorId,
        tagKey: 'INADIMPLENTE',
        automatic: true,
      },
    )
  }
}

/**
 * "SAIR" no WhatsApp revoga o opt-in de marketing (§8).
 *
 * Revoga só o marketing: a confirmação do banho que o tutor agendou continua saindo,
 * por execução de contrato (RN-06). Quem manda "SAIR" quer parar de receber oferta,
 * não perder o lembrete do próprio agendamento.
 */
export async function handleMensagemRecebida(payload: unknown): Promise<boolean> {
  const event = MensagemRecebidaSchema.parse(payload)
  const word = event.body.trim().toUpperCase()
  if (!OPT_OUT_WORDS.has(word)) return false

  await withTenant(event.tenantId, (tx: TenantTransaction) =>
    recordConsentsIn(tx, {
      tenantId: event.tenantId,
      tutorId: event.tutorId,
      transitions: [{ channel: 'WHATSAPP', granted: false, purpose: 'MARKETING', source: 'WHATSAPP' }],
    }),
  )

  await invalidateTutor(event.tenantId, event.tutorId)
  await publishEvent(TUTOR_ROUTING_KEYS.tutorConsentimentoRevogado, {
    tenantId: event.tenantId,
    tutorId: event.tutorId,
    channel: 'WHATSAPP',
    purpose: 'MARKETING',
    version: 'whatsapp-opt-out',
  })
  return true
}

/**
 * `tutors.pets_count`, alimentado por MOD-PET.
 *
 * Reconta em vez de incrementar: a entrega do RabbitMQ é *ao menos uma vez*, e um
 * contador incrementado processaria a mesma mensagem duas vezes sem perceber. A
 * consulta lê `pet_tutors`, tabela de outro módulo — o preço de manter um contador
 * que não pode divergir, e o motivo de a recontagem viver aqui e não numa rotina de
 * reparo noturna.
 */
export async function handlePetCriado(payload: unknown): Promise<void> {
  const event = PetCriadoSchema.parse(payload)
  await recountPets(event.tenantId, event.primaryTutorId)
}

export async function handlePetVinculoAlterado(payload: unknown): Promise<void> {
  const event = PetVinculoAlteradoSchema.parse(payload)
  await recountPets(event.tenantId, event.tutorId)
}

async function recountPets(tenantId: string, tutorId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const petsCount = await tx.petTutor.count({
      where: { tutorId, unlinkedAt: null, pet: { deletedAt: null } },
    })
    await tx.tutor.updateMany({ where: { id: tutorId }, data: { petsCount } })
  })
  await invalidateTutor(tenantId, tutorId)
}

// ─── Ligação com o broker ────────────────────────────────────────────────────

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'atendimento.concluido': handleAtendimentoConcluido,
  'lancamento.criado': handleLancamentoCriado,
  'mensagem.recebida': handleMensagemRecebida,
  'pet.criado': handlePetCriado,
  'pet.vinculo.alterado': handlePetVinculoAlterado,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startTutorConsumers(): Promise<void> {
  if (loadEnv().DISABLE_EVENTS) {
    logger.debug('consumo de eventos desabilitado')
    return
  }

  try {
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

    // Um por vez: os handlers escrevem em transação e a ordem entre eventos do
    // mesmo tutor importa (dois lançamentos seguidos, o último é que vale).
    await channel.prefetch(1)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE }, 'consumidores de evento no ar')
  } catch (error) {
    // Não derruba o serviço: a API de tutores continua funcionando sem o broker.
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
    // Reenfileirar aqui produziria loop apertado sobre a mesma falha.
    logger.error({ err: error, routingKey }, 'falha ao processar evento')
    channel.nack(message, false, false)
  }
}

export async function stopTutorConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
