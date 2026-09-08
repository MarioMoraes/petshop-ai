import { withTenant } from '@petshop/db'
import { DOCUMENT_KIND_LABELS, ROLE_LABELS, type DocumentKind } from '@petshop/shared-types'
import { z } from 'zod'
import { logger } from '../../lib/logger.js'
import { getMessagingPort } from './messaging-port.js'

/**
 * Os avisos que o **produto** manda (MOD-NOTIF-06 a 09).
 *
 * Eles moram aqui, e não no messaging-service, por uma razão que vale para o sistema
 * inteiro: **o messaging é o motor e não decide nada.** Ele recebe um pedido de envio e
 * cumpre a fila, os gates e o provedor. Quem traduz um fato do domínio — um recibo
 * emitido, um convite aceito — em "mande esta mensagem para esta pessoa" é este serviço,
 * que já faz isso para agendamento, taxi, aniversário e cobrança. Um segundo consumidor
 * de evento dentro do motor criaria duas topologias de fila para o mesmo propósito.
 *
 * Diverge do §8 do PRD, que dá esses quatro consumidores ao messaging. A divergência é
 * de endereço, não de comportamento: as mensagens são as mesmas, e o `dedupeKey` de cada
 * uma continua sendo o que protege contra o reprocesso.
 *
 * **Estes quatro não passam por `automations`.** Recibo e boas-vindas não são campanha:
 * não há interruptor para o petshop desligar o e-mail que entrega o comprovante que ele
 * mesmo emitiu, nem o que ensina um funcionário novo a entrar no sistema.
 */

const ReciboEmitidoSchema = z.object({
  tenantId: z.uuid(),
  receiptId: z.uuid(),
  tutorId: z.uuid(),
  number: z.string(),
  documentId: z.uuid().nullish(),
  amount: z.string().nullish(),
})

const PrescricaoEmitidaSchema = z.object({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  number: z.string(),
  petId: z.uuid(),
  tutorId: z.uuid().nullish(),
})

const OnboardingConcluidoSchema = z.object({
  tenantId: z.uuid(),
  adminUserId: z.uuid().nullish(),
})

const ConviteAceitoSchema = z.object({
  tenantId: z.uuid(),
  invitationId: z.uuid(),
  userId: z.uuid(),
  roleKey: z.string(),
})

/**
 * AC-01 de MOD-NOTIF-06 — o recibo sai por e-mail, com o PDF anexo.
 *
 * O documento pode estar `PENDING` neste instante: o número nasce dentro da transação
 * do pagamento e o arquivo chega depois. Isso **não** é problema — o despacho segura a
 * mensagem enquanto o papel não fica pronto (AC-04 de MOD-NOTIF-05), e é por isso que
 * este handler não espera nem verifica.
 */
export async function handleReciboEmitido(payload: unknown): Promise<void> {
  const event = ReciboEmitidoSchema.parse(payload)

  /**
   * Recibo anterior ao MOD-DOC não tem documento, e o backfill só alcançou os que
   * tinham tenant vivo. Sem documento não há o que anexar — e um e-mail dizendo "segue
   * o recibo" sem recibo é pior que e-mail nenhum.
   */
  if (!event.documentId) {
    logger.debug({ receiptId: event.receiptId }, 'recibo sem documento: nada a enviar')
    return
  }

  await getMessagingPort().enqueue({
    tenantId: event.tenantId,
    tutorId: event.tutorId,
    documentId: event.documentId,
    templateKey: 'receipt_issued',
    // O documento, e não o recibo: é ele que identifica o papel de forma estável, e é
    // o reprocesso de emissão que pode republicar o mesmo evento.
    dedupeKey: `receipt-issued:${event.documentId}`,
    variables: {
      'documento.numero': event.number,
      'documento.tipo': DOCUMENT_KIND_LABELS.RECEIPT,
      'financeiro.valor_pago': event.amount ?? '',
    },
  })
}

/**
 * AC-01 de MOD-NOTIF-07 — o receituário chega ao titular, com o pet no assunto.
 *
 * **Filtra-se por titularidade, não por tipo** (AC-02, e a mesma regra do MOD-DOC-10).
 * Documento sem tutor é papel interno do tenant, e um tipo novo que nasça amanhã fica
 * de fora por padrão em vez de vazar por esquecimento.
 */
export async function handlePrescricaoEmitida(payload: unknown): Promise<void> {
  const event = PrescricaoEmitidaSchema.parse(payload)
  if (!event.tutorId) return

  const pet = await withTenant(event.tenantId, (tx) =>
    tx.pet.findUnique({ where: { id: event.petId }, select: { name: true } }),
  )

  await getMessagingPort().enqueue({
    tenantId: event.tenantId,
    tutorId: event.tutorId,
    petId: event.petId,
    documentId: event.documentId,
    templateKey: 'document_issued',
    dedupeKey: `document-issued:${event.documentId}`,
    variables: {
      'pet.nome': pet?.name ?? '',
      'documento.tipo': documentLabel('PRESCRIPTION'),
      'documento.numero': event.number,
    },
  })
}

/**
 * AC-01 de MOD-NOTIF-08 — as boas-vindas que fecham o onboarding.
 *
 * Vai a quem terminou o wizard, e o `dedupeKey` é o tenant: o onboarding se conclui uma
 * vez só, e boas-vindas em duplicata é a primeira impressão do produto errando (AC-03).
 */
export async function handleOnboardingConcluido(payload: unknown): Promise<void> {
  const event = OnboardingConcluidoSchema.parse(payload)
  if (!event.adminUserId) {
    logger.warn({ tenantId: event.tenantId }, 'onboarding concluído sem ator: sem boas-vindas')
    return
  }

  await getMessagingPort().enqueue({
    tenantId: event.tenantId,
    recipientKind: 'USER',
    userId: event.adminUserId,
    templateKey: 'tenant_welcome',
    dedupeKey: `tenant-welcome:${event.tenantId}`,
    variables: {},
  })
}

/**
 * AC-01 de MOD-NOTIF-09 — o primeiro acesso de um membro da equipe.
 *
 * O gatilho é o **aceite do convite**, que é o instante em que o vínculo passa a
 * `ACTIVE`. Mudança de papel semanas depois não dispara nada: aviso operacional ficou
 * fora do escopo por decisão (AC-03).
 */
export async function handleConviteAceito(payload: unknown): Promise<void> {
  const event = ConviteAceitoSchema.parse(payload)

  await getMessagingPort().enqueue({
    tenantId: event.tenantId,
    recipientKind: 'USER',
    userId: event.userId,
    templateKey: 'user_welcome',
    // O convite, e não o usuário: o mesmo funcionário pode ser convidado de novo depois
    // de sair, e nesse caso as boas-vindas devem sair outra vez.
    dedupeKey: `user-welcome:${event.invitationId}`,
    variables: { 'equipe.papel': roleLabel(event.roleKey) },
  })
}

function documentLabel(kind: DocumentKind): string {
  return DOCUMENT_KIND_LABELS[kind] ?? 'documento'
}

/** O papel por extenso. A chave crua no corpo do e-mail leria como erro de sistema. */
function roleLabel(roleKey: string): string {
  return (ROLE_LABELS as Record<string, string>)[roleKey] ?? roleKey
}
