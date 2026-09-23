import { getMaintenancePrisma, withTenant } from '@petshop/db'
import { whatsappWarmupCap } from '@petshop/shared-types'
import { publishEvent } from '../../shared/events.js'
import { tenantOperational } from '../../shared/tenant-status.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { consumeDailySlot, consumeRateSlot } from '../../shared/redis.js'
import { loadEnv } from '../../config/env.js'
import { formatAddress, loadIssuer } from '@petshop/documents'
import { templateAuthorOf } from '@petshop/shared-types'
import { openCipher } from './crypto.js'
import { renderBrandEmail } from './brand.js'
import { planAttachment, type AttachmentPlan } from './attachments.js'
import { portFor } from './ports/registry.js'
import { allows, loadConsents } from './consent.js'
import { marketingCapReached } from './frequency.js'
import { isSuppressed, suppress } from './suppressions.js'
import { loadSettings } from './settings.js'
import { markBanned, warmupStartedAt } from './whatsapp.js'
import { switchToEmail } from './fallback.js'
import { sendPushCompanion } from './push.js'
import { tenantToday } from './window.js'

/**
 * O worker (MOD-CRM-03).
 *
 * Duas coisas que ele faz e que parecem redundantes até se olhar o intervalo entre
 * enfileirar e enviar:
 *
 * - **Revalida antes de despachar** (RN-03). Uma mensagem pode esperar doze horas na
 *   fila, e nesse tempo o tutor pode ter pedido para parar no balcão, o pet pode ter
 *   morrido e a dívida pode ter sido paga. Checar só na entrada é checar no momento
 *   errado — e das quatro revalidações a mais cara de errar é a do óbito, que é o AC-02
 *   de MOD-CRM-06.
 * - **Cobra o teto no despacho, não na criação.** Um teto cobrado ao enfileirar
 *   recusaria a mensagem; cobrado aqui, ele apenas adia — que é o comportamento que a
 *   RN-05 pede.
 *
 * O backoff é 1min/5min/30min/2h e a quinta falha mata a mensagem (AC-05).
 */

const BACKOFF_MINUTES = [1, 5, 30, 120]
const MAX_ATTEMPTS = 5

/**
 * De quanto em quanto tempo reexaminar a fila de um canal que caiu.
 *
 * Dez minutos, e não o backoff normal: a volta do WhatsApp não depende de nada que
 * este serviço faça — depende do dono reconectar o celular. Insistir de minuto em
 * minuto só encheria o log; esperar duas horas atrasaria o retorno sem motivo.
 */
const CHANNEL_DOWN_RETRY_MINUTES = 10

/**
 * De quanto em quanto tempo reexaminar uma mensagem cujo documento ainda não ficou
 * pronto (AC-04 de MOD-NOTIF-05).
 *
 * Cinco minutos, que é a ordem de grandeza do reprocesso de documento do MOD-DOC. A
 * espera não é retentativa: nada falhou, e por isso ela não consome `attempts` nem
 * caminha para `DEAD`. Quem a encurta é o consumidor de `documento.emitido`, que ainda
 * não existe — enquanto não existir, o relógio resolve sozinho, só mais devagar.
 */
const DOCUMENT_PENDING_RETRY_MINUTES = 5

/**
 * A partir de quando uma posse do worker é abandono.
 *
 * `SENDING` é o estado em que a mensagem fica **enquanto** o worker fala com o
 * provedor, e os dois adaptadores desistem antes disso: doze segundos a Evolution,
 * oito o Resend. Dez minutos é ordem de grandeza acima de qualquer envio legítimo,
 * então uma linha mais velha que isto não está enviando — o processo que a tomou
 * morreu no meio, e sem alguém para recolhê-la ela fica em `SENDING` para sempre.
 */
const LEASE_TIMEOUT_MINUTES = 10

/** RN-05: intervalo com jitter entre disparos. Rajada uniforme é assinatura de robô. */
const JITTER_MIN_MS = 2_000
const JITTER_MAX_MS = 6_000

export interface DispatchSummary {
  picked: number
  sent: number
  failed: number
  blocked: number
  throttled: number
}

/**
 * Um passo do worker, para **um** tenant.
 *
 * A varredura cross-tenant é do job, que abre o escopo de plataforma; aqui já se está
 * dentro de um tenant, e é o que permite a transação com RLS ligada.
 */
export async function dispatchTenant(
  tenantId: string,
  options: { now?: Date; jitter?: boolean } = {},
): Promise<DispatchSummary> {
  const now = options.now ?? new Date()
  const summary: DispatchSummary = { picked: 0, sent: 0, failed: 0, blocked: 0, throttled: 0 }

  const settings = await withTenant(tenantId, (tx) => loadSettings(tx, tenantId))

  /**
   * A conta do estabelecimento, uma vez por passada e não uma por mensagem.
   *
   * **Isto não é o interruptor do CRM logo abaixo.** `enabled` é a decisão do petshop
   * sobre quando começar a falar com a base dele; isto é a nossa, sobre um petshop que
   * parou de pagar — e por isso ela cala o tutor mas não o administrador, que precisa
   * justamente receber o aviso dizendo por quê.
   */
  const operates = await tenantOperational(tenantId)

  /**
   * O motor desligado **não** cala o e-mail de equipe (AC-04 de MOD-NOTIF-02).
   *
   * Até o MOD-NOTIF esta linha era um `return` seco, e ele estaria certo enquanto todo
   * destinatário fosse cliente: `enabled` é a decisão de quem responde pelo número do
   * petshop sobre quando começar a falar com a base. Um tenant que ainda não ligou o
   * CRM continua precisando receber as boas-vindas do próprio onboarding — barrá-las
   * aqui desligaria justamente a mensagem que ensina a ligar o motor.
   *
   * O enfileiramento já recusa a mensagem de cliente nesse estado; o que sobra na fila
   * é o parque anterior ao desligamento, e ele fica onde está.
   */
  const batch = await withTenant(tenantId, (tx) =>
    tx.message.findMany({
      where: {
        direction: 'OUTBOUND',
        ...(settings.enabled ? {} : { recipientKind: 'USER' as const }),
        status: { in: ['QUEUED', 'SCHEDULED'] },
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
      take: loadEnv().DISPATCH_BATCH_SIZE,
      select: { id: true, recipientKind: true },
    }),
  )

  summary.picked = batch.length
  const today = tenantToday(settings.timezone, now)

  for (const { id, recipientKind } of batch) {
    /**
     * Os três tetos são do cliente (AC-01 de MOD-NOTIF-02).
     *
     * Este é o que mais custou decidir, porque ele protege o **provedor** e não a
     * pessoa: uma rajada uniforme é assinatura de robô, e represá-la é o que mantém o
     * número e o domínio de pé. O que resolve a tensão é o volume — e-mail de equipe é
     * um punhado por semana, contra centenas de lembretes por dia — e a consequência
     * de errar para o outro lado: um convite parado atrás da fila de lembretes de um
     * sábado é um convite que chega no domingo.
     */
    if (
      recipientKind === 'TUTOR' &&
      // Nada sai ao provedor quando a conta está parada: gastar a vaga do minuto aqui
      // faria a fila bloqueada levar horas para esvaziar, a `perMinuteCap` por vez.
      operates &&
      !(await consumeRateSlot(tenantId, settings.perMinuteCap))
    ) {
      summary.throttled += 1
      // Sem `break` disfarçado: o teto é por minuto, e as restantes do lote ficam
      // para a passada seguinte — trinta segundos depois.
      break
    }

    const outcome = await dispatchOne(tenantId, id, settings, today, now, operates)
    if (outcome === 'sent') summary.sent += 1
    else if (outcome === 'blocked') summary.blocked += 1
    else if (outcome === 'throttled') summary.throttled += 1
    else summary.failed += 1

    if (options.jitter !== false && outcome === 'sent') await sleep(jitterMs())
  }

  if (summary.sent > 0 || summary.failed > 0) {
    recordMetric({ metric: 'messages_dispatched', tenantId, value: summary.sent, unit: 'count' })
  }

  return summary
}

type Outcome = 'sent' | 'failed' | 'blocked' | 'throttled'

interface PreparedMessage {
  recipientKind: 'TUTOR' | 'USER'
  templateKey: string
  tutorId: string | null
  userId: string | null
  petId: string | null
  documentId: string | null
  originType: string | null
  channel: 'WHATSAPP' | 'EMAIL'
  category: 'TRANSACTIONAL' | 'OPERATIONAL' | 'MARKETING'
  attempts: number
  /** O texto do segundo canal, cifrado. Só a presença importa aqui (ver `fallback.ts`). */
  fallbackBodyEncrypted: string | null
  id: string
  originId: string | null
  /** O aviso no aparelho, cifrado (ver `push.ts`). */
  pushTitleEncrypted: string | null
  pushBodyEncrypted: string | null
}

/**
 * O motivo que o painel mostra ao lado do endereço suprimido. "Número sem WhatsApp" diz
 * à recepção o que conferir com o cliente; "devolução definitiva" não diz nada.
 */
function suppressionReasonOf(errorCode: string | null | undefined) {
  return errorCode === 'NOT_ON_WHATSAPP' ? ('NOT_ON_WHATSAPP' as const) : ('HARD_BOUNCE' as const)
}

async function dispatchOne(
  tenantId: string,
  messageId: string,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  today: string,
  now: Date,
  operates: boolean,
): Promise<Outcome> {
  // A "lease" do worker: só quem consegue mover a mensagem para SENDING a envia. Dois
  // processos na mesma fila é o caso normal em produção, e sem isto os dois enviariam.
  const claimed = await withTenant(tenantId, (tx) =>
    tx.message.updateMany({
      where: { id: messageId, status: { in: ['QUEUED', 'SCHEDULED'] } },
      data: { status: 'SENDING' },
    }),
  )
  if (claimed.count === 0) return 'failed'

  // O tipo é explícito porque as duas saídas são genuinamente diferentes — bloquear ou
  // enviar — e deixar a inferência unir os dois literais transforma cada campo em
  // opcional, o que esconde justamente o caso que precisa ficar visível.
  type Prepared =
    | {
        kind: 'block'
        block:
          | 'NO_CONSENT'
          | 'SUPPRESSED'
          | 'NO_CHANNEL'
          | 'PET_DECEASED'
          | 'WEEKLY_CAP'
          | 'TENANT_INACTIVE'
        message: PreparedMessage
      }
    /** Pagou entre a fila e o envio: não é bloqueio, é assunto encerrado (AC-03 de MOD-CRM-08). */
    | { kind: 'cancel'; message: PreparedMessage }
    /** O documento ainda está em preparo (AC-04 de MOD-NOTIF-05). Adia, não falha. */
    | { kind: 'wait'; message: PreparedMessage }
    | {
        kind: 'send'
        message: PreparedMessage
        to: string
        body: string
        subject: string | null
        attachment: AttachmentPlan
        /** O molde de marca, ou `null` quando o texto é do petshop (MOD-NOTIF-04). */
        html: string | null
      }

  const prepared: Prepared = await withTenant(tenantId, async (tx) => {
    const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } })
    const cipher = await openCipher(tx, tenantId)

    const to = safeDecrypt(cipher.decrypt, message.toEncrypted)
    const body = safeDecrypt(cipher.decrypt, message.bodyEncrypted)
    const subject = message.subjectEncrypted
      ? safeDecrypt(cipher.decrypt, message.subjectEncrypted)
      : null

    /**
     * A conta parou, e nada sai em nome dela para o cliente final.
     *
     * **Bloqueia aqui e não ao enfileirar**, que é a diferença entre uma fila e um
     * estoque: represar quinze dias de lembretes e soltá-los todos no minuto em que a
     * assinatura for paga manda ao tutor a confirmação de um banho de anteontem. A linha
     * fica em `BLOCKED` com o motivo, que é o que o painel de entregas mostra.
     *
     * **Só o tutor.** O administrador continua alcançável — os três avisos da conta são
     * `USER`, e são eles que dizem a esta pessoa por que o resto emudeceu.
     */
    if (!operates && message.recipientKind === 'TUTOR') {
      return { kind: 'block' as const, block: 'TENANT_INACTIVE' as const, message }
    }

    /**
     * RN-03: o mundo pode ter mudado desde o enfileiramento.
     *
     * **Só para tutor** (AC-01 de MOD-NOTIF-02). Consentimento, janela de silêncio e os
     * três tetos descrevem a relação comercial com um cliente; nenhum deles diz nada
     * sobre um e-mail dirigido a um membro da equipe, e aplicá-los ali produziria o
     * absurdo de um convite represado até as oito da manhã.
     */
    if (message.recipientKind === 'TUTOR' && message.tutorId) {
      const consents = await loadConsents(tx, message.tutorId)
      if (!allows(consents, message.channel, message.category)) {
        return { kind: 'block' as const, block: 'NO_CONSENT' as const, message }
      }
    }

    /**
     * A supressão, essa, vale para os dois (AC-02 de MOD-NOTIF-02).
     *
     * Ela é do **endereço**, por hash e por tenant, e protege o domínio remetente e não
     * a pessoa: um e-mail que já voltou como inexistente não volta a ser tentado por o
     * dono dele ser da casa.
     */
    if (!to || (await isSuppressed(tx, message.channel, to))) {
      return { kind: 'block' as const, block: to ? ('SUPPRESSED' as const) : ('NO_CHANNEL' as const), message }
    }

    /**
     * AC-04 de MOD-NOTIF-01 — o vínculo pode ter sido encerrado enquanto a mensagem
     * esperava. É a mesma revalidação que a RN-03 faz do consentimento do tutor, pela
     * mesma razão: checar só na entrada é checar no momento errado.
     */
    if (message.recipientKind === 'USER' && message.userId) {
      const membership = await tx.membership.findFirst({
        where: { userId: message.userId, status: 'ACTIVE' },
        select: { id: true },
      })
      if (!membership) return { kind: 'block' as const, block: 'NO_CHANNEL' as const, message }
    }

    /**
     * AC-02 de MOD-CRM-06 — **a falha mais cara que este módulo pode cometer**.
     *
     * Os jobs já filtram pet falecido na seleção, e mesmo assim a pergunta é refeita
     * aqui. A janela entre as duas é real: o aniversário é enfileirado às nove, o tutor
     * comunica o óbito às dez no balcão, a mensagem estava represada pelo teto diário e
     * sai à noite. Uma felicitação a quem enterrou o cão naquela manhã não é um defeito
     * que se conserta pedindo desculpa.
     *
     * A checagem é por `pet_id` e não por categoria: vale para o aniversário, para o
     * lembrete do agendamento que ninguém cancelou e para qualquer texto futuro que
     * nomeie um animal.
     */
    if (message.petId) {
      const pet = await tx.pet.findUnique({
        where: { id: message.petId },
        select: { status: true },
      })
      if (pet?.status === 'DECEASED') {
        return { kind: 'block' as const, block: 'PET_DECEASED' as const, message }
      }
    }

    /**
     * AC-03 de MOD-CRM-08 — pagou entre a fila e o envio.
     *
     * `LEDGER_ENTRY` é a marca da régua de cobrança, e é o que permite fazer esta
     * pergunta sem o motor precisar saber o que é uma régua. Saldo não negativo quer
     * dizer que a dívida que motivou o aviso não existe mais, e o desfecho é
     * `CANCELLED`, não `BLOCKED`: não houve impedimento nenhum — o motivo do envio é que
     * deixou de existir.
     *
     * Cobrar quem acabou de pagar destrói a confiança de que a régua inteira depende.
     */
    if (message.originType === 'LEDGER_ENTRY' && message.tutorId) {
      const tutor = await tx.tutor.findUnique({
        where: { id: message.tutorId },
        select: { balanceCents: true },
      })
      if ((tutor?.balanceCents ?? 0) >= 0) return { kind: 'cancel' as const, message }
    }

    /**
     * O teto semanal, revalidado. `excludeMessageId` porque esta mensagem já está
     * gravada e contaria contra si mesma.
     */
    if (
      message.category === 'MARKETING' &&
      message.tutorId &&
      (await marketingCapReached(tx, {
        tutorId: message.tutorId,
        cap: settings.marketingWeeklyCap,
        now,
        excludeMessageId: messageId,
      }))
    ) {
      return { kind: 'block' as const, block: 'WEEKLY_CAP' as const, message }
    }

    /**
     * O anexo é decidido **aqui**, no despacho, e não no enfileiramento.
     *
     * Entre uma coisa e outra o documento pode ter sido emitido, cancelado ou
     * reprocessado com outro arquivo. A pergunta "os bytes vão junto?" só tem resposta
     * verdadeira no instante do envio — e uma das respostas é "ainda não".
     */
    const attachment = await planAttachment(tx, {
      tenantId,
      documentId: message.documentId,
      channel: message.channel,
    })
    if (attachment.kind === 'pending') return { kind: 'wait' as const, message }
    if (attachment.kind === 'cancelled') return { kind: 'cancel' as const, message }

    /**
     * O molde de marca (MOD-NOTIF-04), montado aqui e não no adaptador.
     *
     * Duas razões, e a segunda é a que decide: o adaptador não tem transação de tenant
     * aberta — ele é um cliente HTTP —, e a identidade visual sai da **mesma** consulta
     * que monta o cabeçalho do PDF. Buscá-la lá dentro seria abrir um contexto de tenant
     * dentro de uma porta de saída, que é exatamente o que as portas existem para evitar.
     *
     * Só para o e-mail: no WhatsApp o corpo é texto, e sempre foi.
     */
    const html =
      message.channel === 'EMAIL' && templateAuthorOf(message.templateKey) === 'SYSTEM'
        ? await brandedHtml(tx, tenantId, body)
        : null

    return { kind: 'send' as const, message, to, body, subject, attachment, html }
  })

  /**
   * O documento não ficou pronto: volta para a fila com hora marcada.
   *
   * Não conta tentativa e não caminha para `DEAD`, porque nada falhou — o Gotenberg
   * estava fora quando o assunto aconteceu, e o reprocesso do MOD-DOC vai emitir. Mandar
   * "segue o recibo" sem recibo é pior que atrasar (AC-04 de MOD-NOTIF-05).
   */
  if (prepared.kind === 'wait') {
    await withTenant(tenantId, (tx) =>
      tx.message.update({
        where: { id: messageId },
        data: {
          status: 'SCHEDULED',
          scheduledFor: new Date(now.getTime() + DOCUMENT_PENDING_RETRY_MINUTES * 60_000),
        },
      }),
    )
    return 'throttled'
  }

  if (prepared.kind === 'cancel') {
    await withTenant(tenantId, (tx) =>
      tx.message.update({ where: { id: messageId }, data: { status: 'CANCELLED' } }),
    )
    return 'blocked'
  }

  /**
   * O WhatsApp ficou inviável entre a fila e o envio — o tutor revogou o canal, o número
   * entrou na supressão. Para quem pediu segundo canal isso é motivo de queda, e não de
   * bloqueio: o e-mail pode estar de pé. Óbito e conta parada **não** caem, porque o
   * impedimento ali não é do canal.
   */
  if (
    prepared.kind === 'block' &&
    prepared.message.channel === 'WHATSAPP' &&
    (prepared.block === 'NO_CONSENT' ||
      prepared.block === 'SUPPRESSED' ||
      prepared.block === 'NO_CHANNEL') &&
    (await switchToEmail(tenantId, messageId, { blockReason: prepared.block }, now))
  ) {
    return 'failed'
  }

  if (prepared.kind === 'block') {
    await withTenant(tenantId, (tx) =>
      tx.message.update({
        where: { id: messageId },
        data: { status: 'BLOCKED', blockReason: prepared.block },
      }),
    )
    await publishEvent('mensagem.bloqueada', {
      tenantId,
      messageId,
      recipientKind: prepared.message.recipientKind,
      tutorId: prepared.message.tutorId,
      userId: prepared.message.userId,
      channel: prepared.message.channel,
      category: prepared.message.category,
      blockReason: prepared.block,
    })
    return 'blocked'
  }

  // O aviso no aparelho do tutor, quando o template tem um (etapa 9 do app).
  //
  // Aqui, e não depois do envio: a mensagem já passou por todos os portões que dizem
  // respeito ao tutor, e o que vem abaixo — tetos de vazão, canal fora do ar — protege
  // o número do petshop, não o celular do cliente. O aviso da van não pode esperar o
  // WhatsApp do petshop voltar. Nunca lança e nunca muda a mensagem.
  await sendPushCompanion(tenantId, prepared.message)

  // O teto diário é só de MARKETING (RN-05): lembrete e aviso de taxi não podem ser
  // represados por um limite pensado para campanha.
  //
  // **Menos durante o aquecimento (RN-06)**, e esta é uma divergência consciente da
  // regra acima: nos sete primeiros dias após o pareamento o teto vale para *todo*
  // envio de WhatsApp, transacional inclusive. Um teto que não conta lembrete não
  // protege o número de nada — e proteger o número é a única coisa que a RN-06 existe
  // para fazer. Fora da janela de aquecimento nada muda: `warmup.daysLeft` é `null` e o
  // caminho volta a ser o de sempre.
  const warmup =
    prepared.message.channel === 'WHATSAPP'
      ? whatsappWarmupCap(settings.dailyCap, await warmupStartedAt(tenantId), now)
      : { cap: settings.dailyCap, daysLeft: null }

  if (
    prepared.message.recipientKind === 'TUTOR' &&
    (prepared.message.category === 'MARKETING' || warmup.daysLeft !== null)
  ) {
    if (!(await consumeDailySlot(tenantId, today, warmup.cap))) {
      await withTenant(tenantId, (tx) =>
        tx.message.update({
          where: { id: messageId },
          data: { status: 'SCHEDULED', scheduledFor: startOfNextDay(now) },
        }),
      )
      return 'throttled'
    }
  }

  const port = portFor(prepared.message.channel)
  const result = await port.send({
    tenantId,
    to: prepared.to,
    subject: prepared.subject,
    body: prepared.body,
    senderName: settings.senderName,
    replyTo: settings.replyToEmail,
    attachment: prepared.attachment.kind === 'file' ? prepared.attachment.attachment : null,
    html: prepared.html,
  })

  if (result.ok) {
    await withTenant(tenantId, async (tx) => {
      await tx.message.update({
        where: { id: messageId },
        data: {
          status: 'SENT',
          sentAt: now,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          errorCode: null,
          errorDetail: null,
          // Saiu: o texto do segundo canal não tem mais serventia, e é dado pessoal.
          fallbackSubjectEncrypted: null,
          fallbackBodyEncrypted: null,
        },
      })
      await tx.messageEvent.create({
        data: {
          tenantId,
          messageId,
          event: 'SENT',
          occurredAt: now,
          // AC-02 de MOD-NOTIF-05: **o histórico registra a troca**. Sem esta linha,
          // "por que o recibo foi por link?" só se responde relendo o tamanho do
          // arquivo — que o reprocesso pode ter mudado desde então.
          raw: attachmentRaw(prepared.attachment) ?? undefined,
        },
      })
    })

    await publishEvent('mensagem.enviada', {
      tenantId,
      messageId,
      recipientKind: prepared.message.recipientKind,
      tutorId: prepared.message.tutorId,
      userId: prepared.message.userId,
      channel: prepared.message.channel,
      providerMessageId: result.providerMessageId,
      sentAt: now.toISOString(),
      // MOD-NOTIF-06: é por aqui que o MOD-LEDGER fecha `receipts.sent_at`, o estado
      // que o schema marcava como inalcançável desde que a coluna nasceu.
      documentId: prepared.message.documentId,
      templateKey: prepared.message.templateKey,
    })
    return 'sent'
  }

  // AC-05 de MOD-CRM-01: a Meta bloqueou o número.
  //
  // A ordem aqui é o que faz a regra valer. Primeiro a mensagem volta à fila — ela não
  // errou nada, foi o canal que morreu —, e **só então** a instância cai. Fazer o
  // contrário, dentro do adaptador, deixaria justamente a mensagem que descobriu o
  // banimento para trás: o caminho de falha abaixo escreveria por cima dela.
  //
  // `markBanned` cuida do resto: derruba a instância, avisa o MOD-ADMIN e move para o
  // e-mail tudo o que estava esperando — esta inclusive.
  if (result.errorCode === 'WHATSAPP_BANNED') {
    await withTenant(tenantId, (tx) =>
      tx.message.update({
        where: { id: messageId },
        data: { status: 'QUEUED', attempts: 0, scheduledFor: null },
      }),
    )
    await markBanned(tenantId, result.errorDetail ?? null)
    return 'failed'
  }

  /**
   * O segundo canal (ver `fallback.ts`): para esta mensagem, **qualquer** falha do
   * WhatsApp é motivo de ir para o e-mail — inclusive a queda de canal logo abaixo, que
   * para as outras é só espera. O chamador disse, ao enfileirar, que esperar não serve.
   *
   * A supressão do número que não existe continua valendo: o próximo lembrete desse
   * tutor não deve tentar o mesmo número de novo.
   */
  if (prepared.message.channel === 'WHATSAPP' && prepared.message.fallbackBodyEncrypted) {
    if (result.permanent && result.errorCode !== 'CHANNEL_UNAVAILABLE') {
      await withTenant(tenantId, (tx) =>
        suppress(tx, tenantId, 'WHATSAPP', prepared.to, suppressionReasonOf(result.errorCode)),
      )
    }
    const cause = { errorCode: result.errorCode ?? null, errorDetail: result.errorDetail ?? null }
    if (await switchToEmail(tenantId, messageId, cause, now)) return 'failed'
  }

  // AC-04 de MOD-CRM-01: o canal saiu do ar, a mensagem não errou nada.
  //
  // O celular do dono ficou três dias sem internet e a fila continua íntegra: nada é
  // descartado, nada conta tentativa, e tudo escoa quando ele reconectar. Sem esta
  // saída a mensagem passaria por `CHANNEL_UNAVAILABLE` cinco vezes e morreria — três
  // dias de queda custariam a fila inteira, e o petshop descobriria pelos clientes.
  if (result.errorCode === 'CHANNEL_UNAVAILABLE') {
    await withTenant(tenantId, (tx) =>
      tx.message.update({
        where: { id: messageId },
        data: {
          status: 'SCHEDULED',
          scheduledFor: new Date(now.getTime() + CHANNEL_DOWN_RETRY_MINUTES * 60_000),
          errorCode: result.errorCode ?? null,
          errorDetail: result.errorDetail ?? null,
        },
      }),
    )
    return 'throttled'
  }

  const attempts = prepared.message.attempts + 1
  // Erro permanente não ganha as cinco tentativas: endereço inválido continua inválido
  // na quinta vez, e insistir só queima a reputação do domínio de envio.
  const dead = result.permanent === true || attempts >= MAX_ATTEMPTS
  const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!

  await withTenant(tenantId, async (tx) => {
    await tx.message.update({
      where: { id: messageId },
      data: {
        status: dead ? 'DEAD' : 'QUEUED',
        attempts,
        failedAt: now,
        scheduledFor: dead ? null : new Date(now.getTime() + backoff * 60_000),
        provider: result.provider,
        errorCode: result.errorCode ?? null,
        errorDetail: result.errorDetail ?? null,
      },
    })
    await tx.messageEvent.create({
      data: {
        tenantId,
        messageId,
        event: result.permanent ? 'BOUNCED' : 'FAILED',
        occurredAt: now,
        raw: { errorCode: result.errorCode ?? null, provider: result.provider },
      },
    })

    // Bounce permanente suprime o endereço: continuar tentando um e-mail que não
    // existe é o caminho mais rápido para o domínio do petshop virar spam.
    if (result.permanent && result.errorCode !== 'CHANNEL_UNAVAILABLE') {
      await suppress(
        tx,
        tenantId,
        prepared.message.channel,
        prepared.to,
        suppressionReasonOf(result.errorCode),
      )
    }
  })

  if (dead) {
    await publishEvent('mensagem.falhou', {
      tenantId,
      messageId,
      recipientKind: prepared.message.recipientKind,
      tutorId: prepared.message.tutorId,
      userId: prepared.message.userId,
      channel: prepared.message.channel,
      errorCode: result.errorCode ?? null,
      attempts,
    })
  }

  return 'failed'
}

/**
 * A varredura de todos os tenants com fila.
 *
 * Roda no escopo de plataforma para **descobrir quem tem fila** e volta para o
 * contexto de cada tenant para despachar — a mesma forma dos jobs do MOD-LEDGER.
 */
export async function dispatchPending(now = new Date()): Promise<DispatchSummary> {
  const total: DispatchSummary = { picked: 0, sent: 0, failed: 0, blocked: 0, throttled: 0 }

  // Descobrir é cross-tenant (`app_maintenance`), agir nunca é (`withTenant`) — a
  // mesma separação dos jobs da agenda e do ledger.
  const rows = await getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM messages
     WHERE direction = 'OUTBOUND'
       AND status IN ('QUEUED', 'SCHEDULED')
       AND (scheduled_for IS NULL OR scheduled_for <= ${now})
     LIMIT 200
  `
  const tenantIds = rows.map((row) => row.tenant_id)

  for (const tenantId of tenantIds) {
    try {
      const summary = await dispatchTenant(tenantId, { now })
      total.picked += summary.picked
      total.sent += summary.sent
      total.failed += summary.failed
      total.blocked += summary.blocked
      total.throttled += summary.throttled
    } catch (error) {
      // Um tenant com problema não pode travar a fila dos outros.
      logger.error({ err: error, tenantId }, 'falha ao despachar mensagens do tenant')
    }
  }

  return total
}

/**
 * A posse abandonada, recolhida.
 *
 * `SENDING` é a única transição do motor sem volta própria: quem a escreve é a posse
 * do worker, e quem a apaga é o resultado do envio, no mesmo `dispatchOne`. Entre as
 * duas há uma chamada de rede, e se o processo morre ali — deploy, `pnpm dev`
 * reiniciando, contêiner reciclado — a linha fica em `SENDING` sem que nada no sistema
 * volte a olhar para ela. Era assim que sete mensagens do parque ficaram paradas por
 * cinco dias, visíveis só pelo alerta da plataforma.
 *
 * **A tentativa é contada, e essa é a decisão que importa.** Devolver à fila sem contar
 * seria mais gentil com a mensagem e transformaria em laço eterno justamente o caso
 * pior: um corpo que derruba o processo no meio do envio seria recolhido, retomado,
 * derrubaria de novo, para sempre. Contando, ele percorre as cinco tentativas e morre —
 * e `DEAD` é um estado que alguém vê, no painel de falhas e no sino.
 *
 * **O preço é a duplicata possível.** O provedor pode ter aceitado a mensagem antes de
 * o processo cair, e nesse caso a retomada manda de novo. É o lado certo de errar: o
 * tutor que recebe duas confirmações do mesmo banho fica confuso por um instante; o que
 * não recebe nenhuma perde o horário.
 */
export async function reclaimAbandonedLeases(now = new Date()): Promise<{ reclaimed: number }> {
  const corte = new Date(now.getTime() - LEASE_TIMEOUT_MINUTES * 60_000)

  // Descobrir é cross-tenant, agir nunca é — a mesma separação de `dispatchPending`.
  const rows = await getMaintenancePrisma().$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT tenant_id FROM messages
     WHERE status = 'SENDING'
       AND updated_at <= ${corte}
     LIMIT 200
  `

  let reclaimed = 0
  for (const { tenant_id: tenantId } of rows) {
    try {
      reclaimed += await reclaimTenantLeases(tenantId, corte, now)
    } catch (error) {
      // Um tenant com problema não pode travar a limpeza dos outros.
      logger.error({ err: error, tenantId }, 'falha ao recolher posses abandonadas')
    }
  }

  if (reclaimed > 0) {
    logger.warn({ reclaimed }, 'mensagens recolhidas de SENDING abandonado')
    recordMetric({ metric: 'message_lease_reclaimed', value: reclaimed, unit: 'count' })
  }

  return { reclaimed }
}

async function reclaimTenantLeases(tenantId: string, corte: Date, now: Date): Promise<number> {
  const abandonadas = await withTenant(tenantId, (tx) =>
    tx.message.findMany({
      where: { status: 'SENDING', updatedAt: { lte: corte } },
      select: {
        id: true,
        attempts: true,
        channel: true,
        recipientKind: true,
        tutorId: true,
        userId: true,
      },
    }),
  )

  for (const mensagem of abandonadas) {
    const attempts = mensagem.attempts + 1
    const dead = attempts >= MAX_ATTEMPTS
    const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!

    await withTenant(tenantId, async (tx) => {
      await tx.message.update({
        where: { id: mensagem.id },
        data: {
          status: dead ? 'DEAD' : 'QUEUED',
          attempts,
          failedAt: now,
          scheduledFor: dead ? null : new Date(now.getTime() + backoff * 60_000),
          // O código é do motor, e não do provedor: ninguém respondeu nada. Ele existe
          // para que o painel de falhas não atribua a uma queda do WhatsApp o que foi
          // uma queda nossa.
          errorCode: 'LEASE_EXPIRED',
          errorDetail: `Envio interrompido: o processo não concluiu em ${LEASE_TIMEOUT_MINUTES} minutos.`,
        },
      })
      await tx.messageEvent.create({
        data: {
          tenantId,
          messageId: mensagem.id,
          event: 'FAILED',
          occurredAt: now,
          raw: { errorCode: 'LEASE_EXPIRED' },
        },
      })
    })

    if (dead) {
      await publishEvent('mensagem.falhou', {
        tenantId,
        messageId: mensagem.id,
        recipientKind: mensagem.recipientKind,
        tutorId: mensagem.tutorId,
        userId: mensagem.userId,
        channel: mensagem.channel,
        errorCode: 'LEASE_EXPIRED',
        attempts,
      })
    }
  }

  return abandonadas.length
}

/**
 * Como o arquivo viajou, para a trilha de entrega.
 *
 * Ausente quando não havia documento nenhum: gravar `{attachment:'none'}` em toda
 * mensagem do sistema encheria a tabela de uma informação que só interessa às poucas
 * que carregam papel.
 */
/**
 * A identidade visual do estabelecimento, já em HTML.
 *
 * Uma falha aqui **não** segura o e-mail: cai para o embrulho mínimo e o texto sai
 * igual. Perder a moldura é cosmético; perder o recibo, não.
 */
async function brandedHtml(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  body: string,
): Promise<string | null> {
  try {
    const { issuer } = await loadIssuer(tx, tenantId)
    return renderBrandEmail({
      issuer,
      address: issuer.address ? formatAddress(issuer.address) : null,
      body,
    })
  } catch (error) {
    logger.error({ err: error, tenantId }, 'falha ao montar o molde de marca do e-mail')
    return null
  }
}

function attachmentRaw(
  plan: AttachmentPlan,
): { attachment: string; reason?: string } | undefined {
  if (plan.kind !== 'file' && plan.kind !== 'link') return undefined
  return plan.kind === 'file' ? { attachment: 'file' } : { attachment: 'link', reason: plan.reason }
}

function safeDecrypt(decrypt: (payload: string) => string, payload: string): string {
  try {
    return decrypt(payload)
  } catch {
    // Corpo já expurgado pela retenção ou pela anonimização: a mensagem não sai, e o
    // caminho de bloqueio acima trata o endereço vazio.
    return ''
  }
}

function jitterMs(): number {
  return JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS))
}

function startOfNextDay(now: Date): Date {
  return new Date(now.getTime() + 12 * 3_600_000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
