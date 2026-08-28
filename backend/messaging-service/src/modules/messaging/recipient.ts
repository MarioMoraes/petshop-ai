import type { TenantTransaction } from '@petshop/db'
import type {
  MessageBlockReason,
  MessageCategory,
  MessageChannel,
  MessageChannelPref,
} from '@petshop/shared-types'
import { loadConsents, allows } from './consent.js'
import { decryptOrPlaceholder, type MessageCipher } from './crypto.js'
import { isSuppressed } from './suppressions.js'
import { channelAvailable } from './ports/registry.js'

/**
 * Para onde a mensagem vai, e por qual canal (AC-02 de MOD-CRM-03).
 *
 * A escolha do canal `AUTO` é uma cascata com quatro perguntas, nesta ordem: o tutor
 * **tem** o contato? o canal está **de pé** no tenant? o **consentimento** cobre esta
 * categoria? o endereço está **suprimido**? WhatsApp primeiro, e-mail como queda.
 *
 * O caso sem nenhum canal viável **não é erro do chamador**: a mensagem nasce
 * `BLOCKED` com o motivo. Devolver 4xx faria cada consumidor de evento distinguir "eu
 * errei" de "esse tutor não pode receber", e a tentação seria tratar as duas como
 * falha e reprocessar para sempre.
 */

export interface Delivery {
  channel: MessageChannel
  address: string
}

export type DeliveryDecision =
  | { ok: true; delivery: Delivery }
  | { ok: false; reason: MessageBlockReason; channel: MessageChannel }

interface Candidate {
  channel: MessageChannel
  address: string | null
}

export async function resolveDelivery(
  tx: TenantTransaction,
  cipher: MessageCipher,
  options: {
    tutorId: string
    preference: MessageChannelPref
    category: MessageCategory
  },
): Promise<DeliveryDecision> {
  const tutor = await tx.tutor.findUnique({
    where: { id: options.tutorId },
    select: { phoneEncrypted: true, emailEncrypted: true },
  })

  const candidates: Candidate[] = [
    {
      channel: 'WHATSAPP',
      address: tutor ? decryptOrPlaceholder(cipher, tutor.phoneEncrypted) || null : null,
    },
    {
      channel: 'EMAIL',
      address: tutor ? decryptOrPlaceholder(cipher, tutor.emailEncrypted) || null : null,
    },
  ]

  const wanted =
    options.preference === 'AUTO'
      ? candidates
      : candidates.filter((candidate) => candidate.channel === options.preference)

  const consents = await loadConsents(tx, options.tutorId)

  // O motivo do **último** candidato recusado é o que vai para a mensagem: é o mais
  // específico que se pode dizer. "Sem canal" quando nem contato existe; "sem
  // consentimento" quando existe contato mas o tutor não quer.
  let reason: MessageBlockReason = 'NO_CHANNEL'
  let blockedChannel: MessageChannel = wanted[0]?.channel ?? 'EMAIL'

  for (const candidate of wanted) {
    if (!candidate.address) continue
    if (!channelAvailable(candidate.channel)) continue

    blockedChannel = candidate.channel

    if (!allows(consents, candidate.channel, options.category)) {
      reason = 'NO_CONSENT'
      continue
    }

    if (await isSuppressed(tx, candidate.channel, candidate.address)) {
      reason = 'SUPPRESSED'
      continue
    }

    return { ok: true, delivery: { channel: candidate.channel, address: candidate.address } }
  }

  return { ok: false, reason, channel: blockedChannel }
}
