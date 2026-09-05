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
    tenantId: string
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
    // Por tenant: o WhatsApp está de pé para quem pareou o número, não para a
    // instalação inteira. É esta pergunta que faz o petshop sem WhatsApp cair para o
    // e-mail em vez de enfileirar algo que nunca sairia.
    if (!(await channelAvailable(candidate.channel, options.tenantId))) continue

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

/**
 * O destino imposto pelo chamador (MOD-PORTAL-09, AC-02).
 *
 * A cascata acima responde "para onde mandar" perguntando à ficha. Esta função existe
 * para o caso em que a ficha ainda **não sabe** o endereço: o tutor está provando que
 * possui um telefone ou um e-mail novo, e mandar o código para o contato antigo provaria
 * a posse do contato que ele quer trocar.
 *
 * Três das quatro perguntas continuam valendo, e a que sai é nomeada de propósito:
 *
 * - **canal de pé no tenant?** Sim, continua. Um WhatsApp não pareado não entrega código
 *   nenhum, e a mensagem nasceria `BLOCKED` com o motivo certo.
 * - **endereço suprimido?** Sim, continua. A supressão é do endereço, não da ficha: quem
 *   pediu para não receber nada nosso não volta a receber por alguém ter digitado o
 *   endereço dele numa tela nossa.
 * - **consentimento?** **Não se aplica**, e é a única dispensa. Consentimento é do
 *   titular da ficha, e este endereço ainda não é dela — a linha de `tutor_consents` que
 *   o cobriria não existe. O que autoriza o envio é a categoria: `MARKETING` nunca chega
 *   aqui (o chamador é recusado antes), e o que sobra é execução de contrato a pedido
 *   explícito de quem está do outro lado do formulário.
 */
export async function resolveOverrideDelivery(
  tx: TenantTransaction,
  options: { tenantId: string; channel: MessageChannel; address: string },
): Promise<DeliveryDecision> {
  if (!(await channelAvailable(options.channel, options.tenantId))) {
    return { ok: false, reason: 'NO_CHANNEL', channel: options.channel }
  }

  if (await isSuppressed(tx, options.channel, options.address)) {
    return { ok: false, reason: 'SUPPRESSED', channel: options.channel }
  }

  return { ok: true, delivery: { channel: options.channel, address: options.address } }
}
