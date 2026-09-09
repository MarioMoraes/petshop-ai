import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { Prisma, withTenant } from '@petshop/db'
import { EVENTS_DLX, EVENTS_EXCHANGE } from '@petshop/shared-types'
import { z } from 'zod'
import { loadEnv } from '../../config/env.js'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { invalidatePackages } from '../../shared/redis.js'
import type { ActorContext } from './actor.js'
import { openAccount, postEntry } from './accounts.js'
import { absorbLeftoverCredit } from './allocation.js'
import { publishPosted, reverseEntry } from './entries.js'
import { redeemCredit, suspendPurchasesForPet } from './packages.js'

/**
 * Eventos que o financeiro **consome** (PRD financeiro_tutor_05 §8).
 *
 * `atendimento.concluido` é o gatilho de 90% dos débitos deste módulo, e é o evento
 * que fecha o laço que faltava: o check-out já o publicava desde o MOD-AGENDA, e o
 * tutor-service já escutava `lancamento.criado` do outro lado — só não havia ninguém
 * no meio para transformar um no outro.
 */

/**
 * **O nome da fila não acompanhou a migração**, e é a regra da consolidação: fila do
 * RabbitMQ é identidade em infraestrutura. Renomeá-la junto com o código deixaria a fila
 * antiga órfã, com as mensagens em trânsito dentro dela — e aqui a mensagem em trânsito
 * é um `atendimento.concluido`, ou seja, um débito que nunca chega à conta do tutor. O
 * sintoma não é erro no log: é um extrato a menos.
 */
const QUEUE = 'billing-ledger-service.events'

/**
 * O que o motor de mensageria conta (MOD-NOTIF-06).
 *
 * `documentId` é anulável porque a esmagadora maioria das mensagens não carrega papel
 * nenhum — lembrete, confirmação, aviso de taxi. O handler sai cedo nesses casos.
 */
const MensagemEnviadaSchema = z.object({
  tenantId: z.uuid(),
  messageId: z.uuid(),
  channel: z.enum(['WHATSAPP', 'EMAIL']),
  sentAt: z.iso.datetime(),
  documentId: z.uuid().nullish(),
})

const AtendimentoConcluidoSchema = z.object({
  tenantId: z.uuid(),
  appointmentId: z.uuid(),
  petId: z.uuid(),
  tutorId: z.uuid(),
  items: z.array(
    z.object({
      serviceId: z.uuid(),
      label: z.string(),
      priceCents: z.number().int().min(0),
    }),
  ),
  totalCents: z.number().int().min(0),
})

const AtendimentoAnuladoSchema = z.object({
  tenantId: z.uuid(),
  attendanceId: z.uuid(),
  appointmentId: z.uuid().nullable(),
  tutorId: z.uuid(),
  reason: z.string(),
  voidedBy: z.uuid().nullable().optional(),
})

const PetObitoSchema = z.object({ tenantId: z.uuid(), petId: z.uuid() })

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

const TutorAnonimizadoSchema = z.object({ tenantId: z.uuid(), tutorId: z.uuid() })

// ─── O débito do atendimento ─────────────────────────────────────────────────

/**
 * AC-01 e AC-05 de MOD-LEDGER-02 — o atendimento terminou.
 *
 * Item a item: o que estiver coberto por pacote ativo consome um crédito e vira
 * lançamento informativo de valor zero; o resto soma num **único** débito em dinheiro
 * com `source = (ATTENDANCE, appointmentId)`.
 *
 * Um débito só, e não um por item, porque é assim que o índice único de idempotência
 * funciona — e porque o tutor lê "Atendimento de 25/08: R$ 120,00", não três linhas
 * que ele precisa somar de cabeça.
 *
 * RN-05: o valor vem do evento, já congelado no check-out. Reconsultar o catálogo aqui
 * cobraria o preço de hoje por um serviço executado ontem.
 */
export async function handleAtendimentoConcluido(payload: unknown): Promise<void> {
  const event = AtendimentoConcluidoSchema.parse(payload)
  const actor: ActorContext = { tenantId: event.tenantId }

  const result = await withTenant(event.tenantId, async (tx) => {
    const account = await openAccount(tx, event.tenantId, event.tutorId)
    let balanceCents = account.balanceCents

    const redeemed: { purchaseId: string; creditsRemaining: number; expiresAt: Date }[] = []
    let cashCents = 0

    for (const item of event.items) {
      const redemption = await redeemCredit(tx, actor, {
        tutorId: event.tutorId,
        petId: event.petId,
        serviceId: item.serviceId,
        serviceLabel: item.label,
        attendanceId: event.appointmentId,
        accountId: account.id,
        balanceCents,
      })

      if (redemption) {
        // O lançamento de resgate vale zero, então o saldo não se move — mas o
        // registro dele já entrou, e é o que aparece no extrato.
        if (redemption.consumed) redeemed.push(redemption)
        continue
      }
      cashCents += item.priceCents
    }

    // AC-05: tudo coberto por pacote = nenhum débito em dinheiro.
    if (cashCents === 0) {
      return { entry: null, redeemed, cashCents }
    }

    const entry = await postEntry(tx, actor, balanceCents, {
      accountId: account.id,
      tutorId: event.tutorId,
      direction: 'DEBIT',
      amountCents: cashCents,
      category: 'SERVICE',
      description: describeAttendance(event.items, cashCents),
      sourceType: 'ATTENDANCE',
      sourceId: event.appointmentId,
      petId: event.petId,
    })
    balanceCents = entry.balanceAfterCents

    // RN-07: crédito solto de pagamento anterior quita este débito agora.
    await absorbLeftoverCredit(tx, event.tenantId, account.id, entry.id, cashCents)

    await recordAudit(tx, {
      tenantId: event.tenantId,
      action: 'ledger.entry_created',
      entity: 'ledger_entry',
      entityId: entry.id,
      after: {
        source: 'atendimento.concluido',
        appointmentId: event.appointmentId,
        amountCents: cashCents,
        coveredByPackage: redeemed.length,
        balanceAfterCents: entry.balanceAfterCents,
      },
    })

    return { entry, redeemed, cashCents }
  })

  if (result.entry) {
    await publishPosted(actor, event.tutorId, result.entry)
  }

  for (const redemption of result.redeemed) {
    await publishEvent('pacote.credito.consumido', {
      tenantId: event.tenantId,
      purchaseId: redemption.purchaseId,
      tutorId: event.tutorId,
      attendanceId: event.appointmentId,
      creditsRemaining: redemption.creditsRemaining,
      expiresAt: redemption.expiresAt.toISOString(),
    })

    // Último crédito queimado: o MOD-CRM usa isto para oferecer a renovação enquanto
    // o cliente ainda está satisfeito, não três meses depois.
    if (redemption.creditsRemaining === 0) {
      await publishEvent('pacote.consumido', {
        tenantId: event.tenantId,
        purchaseId: redemption.purchaseId,
        tutorId: event.tutorId,
      })
    }
  }

  if (result.redeemed.length > 0) {
    await invalidatePackages(event.tenantId, event.tutorId)
  }
}

/**
 * "Banho e Tosa" com um item; "Banho e mais 2 serviços" com vários.
 *
 * O texto vai para `description`, que é o que o tutor lê no extrato — por isso não é
 * a lista completa de ids nem um genérico "Atendimento". Cabe em 200 caracteres por
 * construção.
 */
function describeAttendance(
  items: { label: string; priceCents: number }[],
  cashCents: number,
): string {
  const billable = items.filter((item) => item.priceCents > 0)
  const first = billable[0]?.label ?? 'Atendimento'
  const rest = billable.length - 1

  const text = rest > 0 ? `${first} e mais ${rest} serviço${rest > 1 ? 's' : ''}` : first
  return (cashCents > 0 ? text : `${text} (sem cobrança)`).slice(0, 200)
}

// ─── Ciclo de vida de pet e tutor ────────────────────────────────────────────

/**
 * AC-05 de MOD-LEDGER-07 — o pet morreu.
 *
 * O pacote fica com quem pagou e vai a `SUSPENDED`. O admin decide entre reatribuir a
 * outro pet do tutor e deixar expirar; nunca há reembolso automático.
 *
 * O **ledger não é tocado**: os lançamentos do animal permanecem, porque o histórico
 * financeiro do tutor não desaparece com o pet.
 */
export async function handlePetObito(payload: unknown): Promise<void> {
  const event = PetObitoSchema.parse(payload)
  const suspended = await suspendPurchasesForPet(
    event.tenantId,
    event.petId,
    'Óbito do pet registrado',
  )
  if (suspended > 0) {
    logger.info({ petId: event.petId, suspended }, 'pacotes suspensos por óbito do pet')
  }
}

/**
 * O pet mudou de dono. O pacote **não** vai junto.
 *
 * Quem comprou os quatro banhos foi o tutor anterior; passá-los ao novo dono seria dar
 * a um terceiro o crédito de outra pessoa. Suspende e deixa a decisão com o admin.
 */
export async function handlePetTransferido(payload: unknown): Promise<void> {
  const event = PetTransferidoSchema.parse(payload)
  await suspendPurchasesForPet(event.tenantId, event.petId, 'Pet transferido para outro tutor')
}

/**
 * RN-22 e MOD-TUTOR-09 — dois cadastros viraram um.
 *
 * A conta da origem é fundida na do destino: os lançamentos, pagamentos e pacotes
 * migram, e o saldo do destino passa a ser a soma dos dois. Deixar duas contas para o
 * mesmo tutor unificado seria recriar a caderneta que o módulo veio substituir.
 */
export async function handleTutorMesclado(payload: unknown): Promise<void> {
  const event = TutorMescladoSchema.parse(payload)
  const actor: ActorContext = { tenantId: event.tenantId }

  const moved = await withTenant(event.tenantId, async (tx) => {
    const source = await tx.ledgerAccount.findFirst({
      where: { tutorId: event.sourceId },
      select: { id: true, balanceCents: true },
    })
    if (!source) return null

    const target = await openAccount(tx, event.tenantId, event.targetId)

    await tx.ledgerEntry.updateMany({
      where: { accountId: source.id },
      data: { accountId: target.id, tutorId: event.targetId },
    })
    await tx.payment.updateMany({
      where: { accountId: source.id },
      data: { accountId: target.id, tutorId: event.targetId },
    })
    await tx.packagePurchase.updateMany({
      where: { tutorId: event.sourceId },
      data: { tutorId: event.targetId },
    })

    const merged = target.balanceCents + Number(source.balanceCents)
    await tx.ledgerAccount.update({
      where: { id: target.id },
      data: { balanceCents: BigInt(merged), version: { increment: 1 } },
    })
    await tx.ledgerAccount.update({
      where: { id: source.id },
      data: { balanceCents: 0n },
    })

    await recordAudit(tx, {
      tenantId: event.tenantId,
      action: 'ledger.accounts_merged',
      entity: 'ledger_account',
      entityId: target.id,
      before: { sourceTutorId: event.sourceId, sourceBalanceCents: Number(source.balanceCents) },
      after: { targetTutorId: event.targetId, balanceCents: merged },
    })

    return { balanceCents: merged, previousBalanceCents: target.balanceCents }
  })

  if (!moved) return

  await publishEvent('saldo.alterado', {
    tenantId: event.tenantId,
    tutorId: event.targetId,
    balanceCents: moved.balanceCents,
    previousBalanceCents: moved.previousBalanceCents,
  })
  logger.info({ tenantId: actor.tenantId, targetId: event.targetId }, 'contas de ledger mescladas')
}

/**
 * RN-22 — a anonimização do tutor **não apaga o ledger**.
 *
 * A obrigação de guarda contábil (Código Civil art. 1.194, prazo decadencial fiscal de
 * 5 anos) prevalece sobre o pedido de exclusão, pelo art. 16, I da LGPD. O que se faz
 * é varrer os **campos livres**: `internal_notes`, `notes` do pagamento e o
 * `proof_url` do comprovante — que é o único que pode conter dado bancário de
 * terceiro. Valores, datas e a natureza do serviço permanecem.
 */
export async function handleTutorAnonimizado(payload: unknown): Promise<void> {
  const event = TutorAnonimizadoSchema.parse(payload)

  await withTenant(event.tenantId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({
      where: { tutorId: event.tutorId },
      select: { id: true },
    })
    if (!account) return

    // `updateMany` sobre `ledger_entries` passa pelo trigger de imutabilidade — e
    // passa de propósito: `internal_notes` não é campo protegido por ele, porque
    // redigir juízo de valor sobre o titular é direito dele, não adulteração do livro.
    await tx.ledgerEntry.updateMany({
      where: { accountId: account.id },
      data: { internalNotesEncrypted: null },
    })
    await tx.payment.updateMany({
      where: { accountId: account.id },
      data: { notesEncrypted: null, proofUrlEncrypted: null },
    })
    await tx.packagePurchase.updateMany({
      where: { tutorId: event.tutorId },
      data: { suspensionReasonEncrypted: null },
    })

    await recordAudit(tx, {
      tenantId: event.tenantId,
      action: 'ledger.anonymized',
      entity: 'ledger_account',
      entityId: account.id,
      after: { tutorId: event.tutorId, retained: 'valores, datas e natureza do serviço' },
    })
  })
}

/**
 * MOD-PRONT-09, AC-03 — o atendimento foi anulado.
 *
 * O débito é desfeito por **contrapartida**, nunca por edição: `reverseEntry` gera o
 * lançamento inverso e marca o original como `REVERSED`, e os dois continuam no
 * extrato. O tutor precisa poder ver que houve uma cobrança e que ela foi desfeita —
 * uma linha que some do extrato é indistinguível de uma linha que nunca existiu, e
 * é a segunda coisa que ele vai supor.
 *
 * Idempotente por dois caminhos: o lançamento já estornado é ignorado em silêncio
 * (reentrega do evento), e o atendimento sem débito — tudo coberto por pacote, ou
 * ainda em rascunho — simplesmente não tem o que estornar.
 *
 * O crédito de pacote consumido **não** volta. É decisão consciente e diverge do que
 * uma leitura literal do AC-03 sugeriria: devolver crédito exigiria saber se ele já
 * foi reusado desde então, e um crédito devolvido em cima de um já gasto criaria
 * saldo do nada. O caminho para isso é o lançamento manual, com alguém decidindo.
 */
export async function handleAtendimentoAnulado(payload: unknown): Promise<void> {
  const event = AtendimentoAnuladoSchema.parse(payload)
  if (!event.appointmentId) return

  const actor: ActorContext = {
    tenantId: event.tenantId,
    ...(event.voidedBy ? { actorUserId: event.voidedBy } : {}),
  }

  const entryId = await withTenant(event.tenantId, async (tx) => {
    const entry = await tx.ledgerEntry.findFirst({
      where: {
        sourceType: 'ATTENDANCE',
        sourceId: event.appointmentId,
        direction: 'DEBIT',
        status: 'POSTED',
      },
      select: { id: true },
    })
    return entry?.id ?? null
  })

  if (!entryId) {
    logger.info(
      { tenantId: event.tenantId, attendanceId: event.attendanceId },
      'atendimento anulado sem débito em aberto — nada a estornar',
    )
    return
  }

  await reverseEntry(actor, entryId, `Atendimento anulado: ${event.reason}`.slice(0, 200))

  recordMetric({
    metric: 'attendance_voided_reversal_total',
    tenantId: event.tenantId,
    value: 1,
    unit: 'count',
  })
}

// ─── Ligação com o broker ────────────────────────────────────────────────────

/**
 * AC-01 e AC-02 de MOD-NOTIF-06 — `receipts.sent_at`, enfim alcançável.
 *
 * A coluna está no schema desde o MOD-LEDGER com o comentário "inalcançável até o
 * MOD-NOTIF existir: não há quem envie". Com a entrega por e-mail, a máquina
 * `PENDING → ISSUED → SENT` do §6 do PRD 05 fica completa pela primeira vez.
 *
 * O casamento é por **documento**, não por mensagem: o ledger não sabe o que é um
 * `templateKey` e não deve saber. Ele procura o recibo cujo `document_id` bate com o que
 * viajou, e toda outra mensagem enviada no sistema passa por aqui sem encontrar nada —
 * que é o desfecho correto, e não uma falha.
 *
 * `updateMany` com o estado no `where` é o que fecha a corrida e a idempotência de uma
 * vez: recibo já `SENT` não é reescrito, e recibo `CANCELLED` entre o envio e o callback
 * **não** volta a `SENT`. O broker entrega ao menos uma vez.
 */
export async function handleMensagemEnviada(payload: unknown): Promise<void> {
  const event = MensagemEnviadaSchema.parse(payload)
  if (!event.documentId) return

  const { count } = await withTenant(event.tenantId, (tx) =>
    tx.receipt.updateMany({
      where: { documentId: event.documentId, status: 'ISSUED' },
      data: { status: 'SENT', sentAt: new Date(event.sentAt) },
    }),
  )

  if (count > 0) {
    logger.info(
      { documentId: event.documentId, channel: event.channel },
      'recibo entregue ao tutor',
    )
  }
}

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'atendimento.concluido': handleAtendimentoConcluido,
  'atendimento.anulado': handleAtendimentoAnulado,
  'pet.obito': handlePetObito,
  'pet.transferido': handlePetTransferido,
  'tutor.mesclado': handleTutorMesclado,
  'tutor.anonimizado': handleTutorAnonimizado,
  'mensagem.enviada': handleMensagemEnviada,
}

let connection: ChannelModel | null = null
let channel: Channel | null = null

export async function startLedgerConsumers(): Promise<void> {
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

    // Um por vez: os handlers travam a conta e a ordem entre eventos do mesmo tutor
    // importa. Processar em paralelo só aumentaria a contenção no mesmo `FOR UPDATE`.
    await channel.prefetch(1)
    await channel.consume(QUEUE, (message) => void handleMessage(message))

    logger.info({ queue: QUEUE, keys: Object.keys(HANDLERS) }, 'consumidores do financeiro no ar')
  } catch (error) {
    // Não derruba o serviço: a API do financeiro continua funcionando sem o broker.
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
    // AC-02 de MOD-LEDGER-02 — a reentrega esbarrou no índice único de idempotência.
    // Isso é **sucesso**: o débito já existe e a conta não foi corrompida. Dar nack
    // mandaria para a DLQ um evento que foi processado corretamente da primeira vez.
    if (isDuplicateEvent(error)) {
      recordMetric({ metric: 'ledger_duplicate_event_total', value: 1, unit: 'count' })
      logger.info({ routingKey }, 'evento reentregue barrado pela idempotência')
      channel.ack(message)
      return
    }

    logger.error({ err: error, routingKey }, 'falha ao processar evento')
    // `requeue: false` manda para a DLX, que tem o backoff. Reenfileirar aqui criaria
    // um laço apertado contra um erro que não vai se resolver sozinho.
    channel.nack(message, false, false)
  }
}

function isDuplicateEvent(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function stopLedgerConsumers(): Promise<void> {
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // Encerramento best-effort.
  }
  channel = null
  connection = null
}
