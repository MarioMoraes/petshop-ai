import { hashSearchable, withTenant } from '@petshop/db'
import { openCipher } from './crypto.js'
import { resolveDelivery } from './recipient.js'

/**
 * A queda para o e-mail de uma mensagem que pediu segundo canal (`fallbackToEmail`).
 *
 * Não é o mesmo que o `fallbackPendingToEmail` do banimento, e a diferença é quem
 * decide. Lá é o **canal** que morreu, para todo mundo, e a fila inteira muda. Aqui é
 * **esta** mensagem que não pode esperar: o chamador disse, ao enfileirar, que um
 * WhatsApp atrasado não serve — e então qualquer falha do WhatsApp serve de motivo,
 * inclusive a queda de canal que para as outras mensagens é só espera.
 *
 * Devolve `false` sem tocar em nada quando não há para onde cair — sem texto de e-mail
 * guardado, sem e-mail na ficha, sem consentimento, endereço suprimido. O chamador segue
 * então pelo caminho de sempre, e a mensagem se comporta como se nunca tivesse pedido o
 * segundo canal.
 *
 * Só move a linha que ainda está em `SENDING`: é a posse do worker que chamou, e o
 * `updateMany` condicional é o que impede de reescrever uma linha que outro processo já
 * recolheu.
 */
export async function switchToEmail(
  tenantId: string,
  messageId: string,
  cause: { errorCode?: string | null; errorDetail?: string | null; blockReason?: string },
  now: Date,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const message = await tx.message.findUnique({
      where: { id: messageId },
      select: {
        channel: true,
        recipientKind: true,
        tutorId: true,
        category: true,
        fallbackSubjectEncrypted: true,
        fallbackBodyEncrypted: true,
      },
    })
    if (
      !message ||
      message.channel !== 'WHATSAPP' ||
      message.recipientKind !== 'TUTOR' ||
      !message.tutorId ||
      !message.fallbackBodyEncrypted
    ) {
      return false
    }

    const cipher = await openCipher(tx, tenantId)
    const decision = await resolveDelivery(tx, cipher, {
      tenantId,
      tutorId: message.tutorId,
      preference: 'EMAIL',
      category: message.category,
    })
    if (!decision.ok) return false

    const { count } = await tx.message.updateMany({
      where: { id: messageId, status: 'SENDING' },
      data: {
        channel: 'EMAIL',
        toEncrypted: cipher.encrypt(decision.delivery.address),
        toHash: hashSearchable('messaging:email', decision.delivery.address.toLowerCase()),
        subjectEncrypted: message.fallbackSubjectEncrypted,
        bodyEncrypted: message.fallbackBodyEncrypted,
        fallbackSubjectEncrypted: null,
        fallbackBodyEncrypted: null,
        // A tentativa que falhou foi do outro canal: o e-mail começa do zero, e sai no
        // próximo tique do worker.
        status: 'QUEUED',
        attempts: 0,
        scheduledFor: null,
        blockReason: null,
        errorCode: null,
        errorDetail: null,
      },
    })
    if (count === 0) return false

    // O histórico registra a troca: sem esta linha, "por que chegou por e-mail?" só se
    // responderia sabendo que existiu um WhatsApp antes.
    await tx.messageEvent.create({
      data: {
        tenantId,
        messageId,
        event: 'FAILED',
        occurredAt: now,
        raw: {
          channel: 'WHATSAPP',
          errorCode: cause.errorCode ?? null,
          errorDetail: cause.errorDetail ?? null,
          blockReason: cause.blockReason ?? null,
          fallbackTo: 'EMAIL',
        },
      },
    })
    return true
  })
}
