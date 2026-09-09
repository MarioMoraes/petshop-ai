import { randomUUID } from 'node:crypto'
import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  maskPortalTarget,
  portalChannelOf,
  PORTAL_CHALLENGE_MIN_MS,
  PORTAL_CHALLENGE_TTL_MIN,
  type PortalChallengeInput,
  type PortalChallengeResponse,
  type PortalChannel,
} from '@petshop/shared-types'
import { logger, recordMetric } from '../../shared/logger.js'
import { recordAudit } from '../../shared/audit.js'
import { recordSecurityEvent } from '../../shared/security-events.js'
import { tooManyAttempts } from './errors.js'
import type { ActorContext } from './actor.js'
import {
  generateCode,
  hashCode,
  hashIdentifier,
  hashTutorEmail,
  hashTutorPhone,
  normalizeIdentifier,
} from './crypto.js'
import { getMessagingPort } from './messaging-port.js'
import { checkChallengeRate } from './rate-limit.js'

/**
 * MOD-PORTAL-01 — o pedido de código de acesso.
 *
 * **A regra que organiza este arquivo inteiro: a resposta é a mesma, sempre.** Ficha
 * encontrada, ficha inexistente, ficha anonimizada, honeypot preenchido — todos saem por
 * 202 com o mesmo corpo e o mesmo tempo. O que muda é o que acontece por baixo, e nada
 * disso é observável de fora.
 *
 * O motivo não é elegância. Um 404 aqui transformaria o Portal num oráculo de "fulano é
 * cliente deste petshop?", consultável por qualquer um, sobre qualquer pessoa. Isso é
 * vazamento de dado pessoal por si só, independente de tudo o que vem depois.
 *
 * A linha em `portal_link_challenges` é gravada **mesmo quando não casa com ficha
 * nenhuma**: sem ela, o silêncio na tabela seria a própria resposta que este desenho
 * esconde, e o rate limit não contaria a varredura.
 */

export interface ChallengeRequest {
  actor: ActorContext
  clerkUserId: string
  input: PortalChallengeInput
}

export async function requestChallenge(
  request: ChallengeRequest,
): Promise<PortalChallengeResponse> {
  const startedAt = Date.now()
  const { actor, clerkUserId, input } = request

  const channel = portalChannelOf(input.identifier)
  const response: PortalChallengeResponse = {
    // Substituído pelo id real quando há linha gravada. O honeypot e o estouro de
    // limite devolvem este, que não existe em lugar nenhum — e o `verify` dele falha
    // como qualquer código errado.
    challengeId: randomUUID(),
    channel,
    maskedTarget: maskPortalTarget(input.identifier, channel),
    expiresInMin: PORTAL_CHALLENGE_TTL_MIN,
  }

  try {
    // AC-02 de MOD-PORTAL-11: honeypot preenchido sai por aqui, com a resposta do
    // sucesso e sem tocar em nada. Responder com erro ensinaria o bot a contornar.
    if (input.website) {
      await recordSecurityEvent({
        tenantId: actor.tenantId,
        type: 'LOGIN_FAILED',
        targetEntity: 'portal_challenge',
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { reason: 'HONEYPOT' },
      })
      return response
    }

    const normalized = normalizeIdentifier(input.identifier, channel)
    const identifierHash = hashIdentifier(normalized)

    const verdict = await checkChallengeRate(
      actor.tenantId,
      identifierHash,
      actor.ipAddress ?? null,
    )
    if (verdict !== 'OK') {
      await recordSecurityEvent({
        tenantId: actor.tenantId,
        type: 'LOGIN_FAILED',
        targetEntity: 'portal_challenge',
        targetId: identifierHash,
        ipAddress: actor.ipAddress ?? null,
        metadata: { reason: verdict },
      })
      // O 429 é a **única** resposta diferente da porta, e não vaza nada: ele fala do
      // volume de pedidos, não de quem está do outro lado do identificador.
      throw tooManyAttempts()
    }

    const code = generateCode()
    const created = await withTenant(actor.tenantId, async (tx) => {
      const matches = await findTutors(tx, channel, normalized)
      return createChallenge(tx, {
        tenantId: actor.tenantId,
        clerkUserId,
        currentUserId: actor.actorUserId ?? null,
        identifierHash,
        channel,
        code,
        matches,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    })

    response.challengeId = created.id

    if (created.recipientTutorId) {
      // O envio fica **fora** da transação: falha de mensageria não pode desfazer a
      // linha que o rate limit precisa ter contado.
      await getMessagingPort().sendAccessCode({
        tenantId: actor.tenantId,
        tutorId: created.recipientTutorId,
        channel,
        code,
        dedupeKey: `portal-code:${created.id}`,
      })
    }

    recordMetric({
      metric: 'portal_challenge_requested_total',
      tenantId: actor.tenantId,
      value: 1,
      unit: 'count',
    })

    return response
  } finally {
    // AC-03 de MOD-PORTAL-11 — o piso de tempo.
    //
    // A busca por ficha existente decifra e compara; a inexistente volta do índice e
    // para. Sem equalizar, a resposta é idêntica e o **cronômetro** conta a diferença:
    // o AC-03 de MOD-PORTAL-01 cairia por medição, não por leitura.
    await floorElapsed(startedAt)
  }
}

interface TutorMatch {
  id: string
  portalUserId: string | null
}

/**
 * A ficha, procurada pelo mesmo hash que o tutor-service grava.
 *
 * Só telefone **primário** e e-mail primário: `phone_alt` fica de fora porque o
 * messaging-service resolve o destinatário pelo contato principal, e casar pelo
 * secundário mandaria o código para um aparelho que não é o que a pessoa está usando.
 *
 * Ficha anonimizada não é ficha (AC-07): a condição está no `where`, e não numa
 * checagem depois, para que não haja caminho que a esqueça.
 */
async function findTutors(
  tx: TenantTransaction,
  channel: PortalChannel,
  normalized: string,
): Promise<TutorMatch[]> {
  const hash = channel === 'EMAIL' ? hashTutorEmail(normalized) : hashTutorPhone(normalized)

  return tx.tutor.findMany({
    where: {
      ...(channel === 'EMAIL' ? { emailHash: hash } : { phoneHash: hash }),
      anonymizedAt: null,
      deletedAt: null,
      status: { not: 'MERGED' },
    },
    select: { id: true, portalUserId: true },
    // Duas fichas com o mesmo contato é o AC-06; a terceira não muda a decisão.
    take: 3,
    orderBy: { createdAt: 'asc' },
  })
}

interface CreateChallengeInput {
  tenantId: string
  clerkUserId: string
  /** O usuário local desta sessão, quando o espelho do Clerk já existe. */
  currentUserId: string | null
  identifierHash: string
  channel: PortalChannel
  code: string
  matches: TutorMatch[]
  ipAddress: string | null
  userAgent: string | null
}

interface CreatedChallenge {
  id: string
  /** Para quem mandar o código. Nulo quando não há a quem mandar. */
  recipientTutorId: string | null
}

async function createChallenge(
  tx: TenantTransaction,
  input: CreateChallengeInput,
): Promise<CreatedChallenge> {
  const ambiguous = input.matches.length > 1

  /**
   * Quem recebe o código.
   *
   * No caso ambíguo o código **é enviado assim mesmo**, para a primeira ficha: as duas
   * compartilham o telefone, então chega ao mesmo aparelho de qualquer jeito. É o que
   * mantém o 409 do AC-06 atrás de uma prova de posse do contato — sem isso, qualquer
   * um descobriria, só chutando números, quais deles pertencem a duas fichas do
   * petshop.
   *
   * Ficha já vinculada a **outra** conta não recebe nada: o 409 do AC-04 vem no
   * `verify`, e mandar o código antes disso só gastaria mensagem avisando o dono
   * legítimo de uma tentativa que não vai a lugar nenhum.
   */
  const first = input.matches[0]
  const recipientTutorId =
    first && !isLinkedElsewhere(first, input.currentUserId) ? first.id : null

  const challenge = await tx.portalLinkChallenge.create({
    data: {
      tenantId: input.tenantId,
      tutorId: first?.id ?? null,
      identifierHash: input.identifierHash,
      channel: input.channel,
      codeHash: '',
      clerkUserId: input.clerkUserId,
      ambiguous,
      expiresAt: new Date(Date.now() + PORTAL_CHALLENGE_TTL_MIN * 60_000),
      ipAddress: input.ipAddress,
    },
    select: { id: true },
  })

  // O hash do código depende do id da linha, então a gravação é em dois passos. É de
  // propósito: sem o id no HMAC, o mesmo código valeria em desafios diferentes.
  await tx.portalLinkChallenge.update({
    where: { id: challenge.id },
    data: { codeHash: hashCode(challenge.id, input.code) },
  })

  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorUserId: null,
    action: 'portal.challenge_requested',
    entity: 'portal_link_challenge',
    entityId: challenge.id,
    after: {
      channel: input.channel,
      matched: input.matches.length > 0,
      ambiguous,
      clerkUserId: input.clerkUserId,
    },
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  })

  if (input.matches.length === 0) {
    logger.debug({ tenantId: input.tenantId }, 'desafio sem ficha correspondente')
  }

  return { id: challenge.id, recipientTutorId }
}

/**
 * A ficha já é de outra conta?
 *
 * A comparação com o usuário atual não é detalhe: sem ela, o tutor que já vinculou o
 * acesso e trocou de celular nunca mais receberia um código — o próprio vínculo dele o
 * barraria, e a saída seria pedir à equipe que o desfizesse.
 */
function isLinkedElsewhere(tutor: TutorMatch, currentUserId: string | null): boolean {
  return tutor.portalUserId !== null && tutor.portalUserId !== currentUserId
}

async function floorElapsed(startedAt: number): Promise<void> {
  const remaining = PORTAL_CHALLENGE_MIN_MS - (Date.now() - startedAt)
  if (remaining <= 0) return
  await new Promise((resolve) => setTimeout(resolve, remaining))
}
