import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { withTenant, type TenantTransaction } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE, PET_ROUTING_KEYS } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../env.js'
import { recordAudit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/events.js'
import { logger } from '../../lib/logger.js'
import { invalidatePet } from '../../lib/redis.js'

/**
 * Eventos que o pet-service **consome** (PRD pets_03 §8, parágrafo final).
 *
 * Os dois primeiros existem porque o ciclo de vida do tutor não pode deixar o pet em
 * estado inválido: anonimizar uma pessoa não pode apagar o histórico clínico do
 * animal, e mesclar dois cadastros não pode duplicar o vínculo com o mesmo pet.
 *
 * TODO(MOD-AGENDA): `atendimento.concluido` alimenta `pets.last_attendance_at`, do
 * mesmo jeito que já faz no tutor-service. O publicador ainda não existe.
 */

const QUEUE = 'pet-service.events'

const TutorAnonimizadoSchema = z.object({
  tenantId: z.uuid(),
  tutorId: z.uuid(),
})

const TutorMescladoSchema = z.object({
  tenantId: z.uuid(),
  sourceId: z.uuid(),
  targetId: z.uuid(),
})

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * O tutor foi anonimizado (LGPD art. 18): os vínculos dele são encerrados.
 *
 * O pet **permanece**, com o prontuário intacto — RN-06 diz que o histórico clínico
 * segue o animal, e apagá-lo junto com a pessoa destruiria informação de saúde de um
 * terceiro. Quando o anonimizado era o responsável principal, o vínculo ativo mais
 * antigo assume, para o pet não ficar sem quem responda por ele (RN-04).
 *
 * Um pet que fica sem nenhum responsável é órfão de propósito: a recepção precisa
 * decidir para quem ele vai, e inventar um titular aqui seria pior que o vazio.
 */
export async function handleTutorAnonimizado(payload: unknown): Promise<string[]> {
  const event = TutorAnonimizadoSchema.parse(payload)

  const affected = await withTenant(event.tenantId, async (tx) => {
    const links = await tx.petTutor.findMany({
      where: { tutorId: event.tutorId, unlinkedAt: null },
    })
    if (links.length === 0) return []

    await tx.petTutor.updateMany({
      where: { tutorId: event.tutorId, unlinkedAt: null },
      data: { unlinkedAt: new Date() },
    })

    for (const link of links) {
      if (link.role === 'PRIMARY') await promoteNextPrimary(tx, link.petId)

      await recordAudit(tx, {
        tenantId: event.tenantId,
        actorUserId: null,
        action: 'pet.tutor_unlinked',
        entity: 'pet',
        entityId: link.petId,
        before: { tutorId: event.tutorId, role: link.role },
        after: { reason: 'tutor.anonimizado' },
      })
    }

    return links.map((link) => link.petId)
  })

  for (const petId of affected) {
    await invalidatePet(event.tenantId, petId, [event.tutorId])
    await publishEvent(PET_ROUTING_KEYS.petVinculoAlterado, {
      tenantId: event.tenantId,
      petId,
      tutorId: event.tutorId,
      action: 'UNLINKED',
      role: 'SECONDARY',
    })
  }

  return affected
}

/**
 * Dois cadastros eram a mesma pessoa: os vínculos da origem passam ao destino.
 *
 * Quando os dois cadastros já apontavam para o mesmo pet — o caso comum, e o motivo
 * de a duplicata ter sido notada —, o da origem é encerrado em vez de movido: o
 * índice `idx_pet_tutor_active` proíbe dois vínculos vivos do mesmo par, e é ele que
 * garante que a mescla não produza um responsável em dobro.
 */
export async function handleTutorMesclado(payload: unknown): Promise<string[]> {
  const event = TutorMescladoSchema.parse(payload)

  const affected = await withTenant(event.tenantId, async (tx) => {
    const links = await tx.petTutor.findMany({
      where: { tutorId: event.sourceId, unlinkedAt: null },
    })
    if (links.length === 0) return []

    const targetLinks = await tx.petTutor.findMany({
      where: { tutorId: event.targetId, unlinkedAt: null },
      select: { petId: true },
    })
    const alreadyLinked = new Set(targetLinks.map((link) => link.petId))

    for (const link of links) {
      if (alreadyLinked.has(link.petId)) {
        await tx.petTutor.update({ where: { id: link.id }, data: { unlinkedAt: new Date() } })
        continue
      }
      await tx.petTutor.update({ where: { id: link.id }, data: { tutorId: event.targetId } })
      alreadyLinked.add(link.petId)
    }

    await recordAudit(tx, {
      tenantId: event.tenantId,
      actorUserId: null,
      action: 'pet.tutor_merged',
      entity: 'tutor',
      entityId: event.targetId,
      before: { tutorId: event.sourceId, petIds: links.map((link) => link.petId) },
      after: { tutorId: event.targetId },
    })

    return links.map((link) => link.petId)
  })

  for (const petId of affected) {
    await invalidatePet(event.tenantId, petId, [event.sourceId, event.targetId])
  }
  return affected
}

/**
 * Promove o vínculo ativo mais antigo a principal. Só age se sobrou alguém: o índice
 * único parcial já garante que não haverá dois principais.
 */
async function promoteNextPrimary(tx: TenantTransaction, petId: string): Promise<void> {
  const next = await tx.petTutor.findFirst({
    where: { petId, unlinkedAt: null, role: 'SECONDARY' },
    orderBy: { linkedAt: 'asc' },
  })
  if (!next) return
  await tx.petTutor.update({ where: { id: next.id }, data: { role: 'PRIMARY' } })
}

// ─── Ligação com o broker ────────────────────────────────────────────────────

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'tutor.anonimizado': handleTutorAnonimizado,
  'tutor.mesclado': handleTutorMesclado,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startPetConsumers(): Promise<void> {
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

    // Um por vez: os handlers escrevem em transação e a ordem entre eventos do mesmo
    // tutor importa — mesclar depois de anonimizar não é a mesma coisa que o inverso.
    await channel.prefetch(1)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE }, 'consumidores de evento no ar')
  } catch (error) {
    // Não derruba o serviço: a API de pets continua funcionando sem o broker.
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

export async function stopPetConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
