import { decryptPlatform, type TenantTransaction } from '@petshop/db'
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
 * Para onde vai o e-mail de um membro da equipe (MOD-NOTIF-01).
 *
 * Três coisas separam esta função da cascata acima, e as três vêm do mesmo fato: um
 * membro da equipe **não é cliente**.
 *
 * - **O canal é sempre o e-mail.** O produto não tem o WhatsApp do funcionário, e o
 *   número que ele porventura tenha na ficha é o de tutor, de outra relação.
 * - **A chave é outra.** `users` é tabela **global**, fora de `RLS_MODELS` e sem política
 *   nenhuma, e o e-mail dela é cifrado com a **chave de plataforma** (HKDF sobre a KEK),
 *   não com a DEK do tenant. Abrir o cifrador errado aqui devolveria **lixo em vez de
 *   erro** — é a pegadinha central da sub-feature. A leitura cabe na mesma transação
 *   porque a guarda de `withTenant` só recusa tabela sob RLS; o que ela **não** pode é
 *   sair do tenant, e por isso quem responde "esta pessoa é da casa?" é `memberships`,
 *   que tem política.
 * - **Não se pergunta consentimento.** `tutor_consents` é a base legal de uma relação
 *   comercial; a relação de trabalho não passa por ali.
 *
 * O que **continua** valendo é a supressão: ela é do endereço, protege o domínio
 * remetente, e um e-mail que já voltou como inexistente não volta a ser tentado por o
 * dono dele ser da casa.
 *
 * AC-04 — vínculo encerrado vira `NO_CHANNEL`. O caminho é o mesmo de um tutor sem
 * contato: a mensagem nasce (ou morre no despacho) `BLOCKED` com o motivo, e a linha
 * fica de pé. É ela a prova de que o convite foi enviado.
 */
export async function resolveUserDelivery(
  tx: TenantTransaction,
  options: { tenantId: string; userId: string },
): Promise<DeliveryDecision> {
  const membership = await tx.membership.findFirst({
    where: { userId: options.userId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!membership) return { ok: false, reason: 'NO_CHANNEL', channel: 'EMAIL' }

  const user = await tx.user.findUnique({
    where: { id: options.userId },
    select: { emailEncrypted: true, status: true },
  })
  if (!user || user.status !== 'ACTIVE') {
    return { ok: false, reason: 'NO_CHANNEL', channel: 'EMAIL' }
  }

  let address: string
  try {
    address = decryptPlatform(user.emailEncrypted)
  } catch {
    // Chave rotacionada sem re-cifrar, ou linha de fixture com lixo: o endereço não
    // existe para efeito de envio, e é o mesmo desfecho de um cadastro sem e-mail.
    return { ok: false, reason: 'NO_CHANNEL', channel: 'EMAIL' }
  }
  if (!address) return { ok: false, reason: 'NO_CHANNEL', channel: 'EMAIL' }

  if (!(await channelAvailable('EMAIL', options.tenantId))) {
    return { ok: false, reason: 'NO_CHANNEL', channel: 'EMAIL' }
  }
  if (await isSuppressed(tx, 'EMAIL', address)) {
    return { ok: false, reason: 'SUPPRESSED', channel: 'EMAIL' }
  }

  return { ok: true, delivery: { channel: 'EMAIL', address } }
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
