import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  PORTAL_MAX_ATTEMPTS,
  type PortalVerifyInput,
  type PortalChannel,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import {
  alreadyLinked,
  ambiguousIdentifier,
  invalidCode,
  tooManyAttempts,
} from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import { recordSecurityEvent } from '../../lib/security-events.js'
import { loadEnv } from '../../env.js'
import type { ActorContext } from './actor.js'
import { codeMatches, hashCode } from './crypto.js'
import { getMessagingPort } from './messaging-port.js'
import { startCooldown } from './rate-limit.js'
import { readPortalContext, type PortalContext } from './me.js'

/**
 * MOD-PORTAL-01, AC-02 — o consumo do código e o nascimento do vínculo.
 *
 * Aqui a resposta **deixa** de ser uniforme, e é correto que deixe: a partir deste
 * ponto quem fala já provou posse do contato, mandando de volta um número que só chegou
 * lá. Guardar segredo dele seria esconder a informação de quem tem direito a ela.
 *
 * Três recusas distintas, cada uma com o seu código:
 *
 * - **422** `ERR_PORTAL_002` — código errado, expirado, já usado, ou desafio de outra
 *   conta. É a resposta de tudo o que não prova nada.
 * - **409** `ERR_PORTAL_003` — a ficha já é de outro acesso. Sem dizer de quem.
 * - **409** `ERR_PORTAL_005` — o contato está em duas fichas, e escolher uma daria a um
 *   deles o extrato do outro.
 */

export interface VerifyRequest {
  actor: ActorContext
  clerkUserId: string
  userId: string
  input: PortalVerifyInput
}

export async function verifyChallenge(request: VerifyRequest): Promise<PortalContext> {
  const { actor, userId } = request

  /**
   * A tentativa errada é contada **antes**, em transação própria, e não junto do erro.
   *
   * Contá-la no mesmo `withTenant` que lança desfaz a contagem: o throw rola a
   * transação para trás e `attempts` volta a zero. O teto de cinco do AC-05 nunca
   * dispararia — e o sintoma seria força bruta funcionando com o código do teto no
   * lugar, aparentemente correto, à vista de todos.
   */
  await registerAttempt(request)

  const linked = await withTenant(
    actor.tenantId,
    (tx) => consumeChallenge(tx, request),
    { userId },
  )

  await publishEvent('tutor.portal_vinculado', {
    tenantId: actor.tenantId,
    tutorId: linked.tutorId,
    userId,
    channel: linked.channel,
  })

  await getMessagingPort().sendWelcome({
    tenantId: actor.tenantId,
    tutorId: linked.tutorId,
    portalUrl: portalUrlOf(linked.slug),
    dedupeKey: `portal-welcome:${linked.tutorId}`,
  })

  recordMetric({
    metric: 'portal_linked_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return withTenant(actor.tenantId, (tx) => readPortalContext(tx, actor.tenantId, linked.tutorId))
}

interface LinkedTutor {
  tutorId: string
  channel: PortalChannel
  slug: string
}

/**
 * Conta a tentativa e, no quinto erro, mata o desafio (AC-05).
 *
 * Fica em transação própria pela razão explicada em `verifyChallenge`. Desafio que não
 * existe, já morreu ou é de outra conta **não** é contado aqui: quem o rejeita é
 * `consumeChallenge`, com a resposta única de código inválido.
 */
async function registerAttempt(request: VerifyRequest): Promise<void> {
  const { actor, clerkUserId, input } = request

  const outcome = await withTenant(actor.tenantId, async (tx) => {
    const challenge = await tx.portalLinkChallenge.findFirst({
      where: {
        id: input.challengeId,
        tenantId: actor.tenantId,
        clerkUserId,
        consumedAt: null,
        blocked: false,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, codeHash: true, attempts: true, identifierHash: true },
    })
    if (!challenge) return null
    if (codeMatches(challenge.codeHash, hashCode(challenge.id, input.code))) return null

    const attempts = challenge.attempts + 1
    // Seis dígitos são 10⁶ combinações; sem este teto um script acerta em minutos.
    const exhausted = attempts >= PORTAL_MAX_ATTEMPTS

    await tx.portalLinkChallenge.update({
      where: { id: challenge.id },
      data: {
        attempts,
        ...(exhausted ? { blocked: true, consumedAt: new Date() } : {}),
      },
    })

    return exhausted
      ? { challengeId: challenge.id, identifierHash: challenge.identifierHash, attempts }
      : null
  })

  if (!outcome) return

  await startCooldown(actor.tenantId, outcome.identifierHash)
  await recordSecurityEvent({
    tenantId: actor.tenantId,
    type: 'LOGIN_FAILED',
    targetEntity: 'portal_link_challenge',
    targetId: outcome.challengeId,
    ipAddress: actor.ipAddress ?? null,
    metadata: { reason: 'CODE_BRUTE_FORCE', attempts: outcome.attempts },
  })
  await publishEvent('portal.acesso_suspeito', {
    tenantId: actor.tenantId,
    identifierHash: outcome.identifierHash,
    ip: actor.ipAddress ?? null,
    attempts: outcome.attempts,
  })

  throw tooManyAttempts('Muitas tentativas. Peça um código novo em alguns minutos.')
}

async function consumeChallenge(
  tx: TenantTransaction,
  request: VerifyRequest,
): Promise<LinkedTutor> {
  const { actor, clerkUserId, userId, input } = request

  const challenge = await tx.portalLinkChallenge.findFirst({
    where: { id: input.challengeId, tenantId: actor.tenantId },
  })

  /**
   * Desafio inexistente, de outra conta, já consumido, bloqueado ou vencido: **a mesma
   * resposta** do código errado.
   *
   * Separá-las contaria a quem tenta em qual dessas situações ele está, e o mais útil
   * de saber é justamente "este desafio existe" — que é o que confirma que o
   * identificador tinha ficha.
   */
  if (
    !challenge ||
    challenge.clerkUserId !== clerkUserId ||
    challenge.consumedAt !== null ||
    challenge.blocked ||
    challenge.expiresAt.getTime() < Date.now()
  ) {
    throw invalidCode()
  }

  if (!codeMatches(challenge.codeHash, hashCode(challenge.id, input.code))) {
    // A contagem já foi gravada por `registerAttempt`, fora desta transação.
    throw invalidCode()
  }

  // Daqui para baixo o código está certo: a pessoa provou posse do contato.
  await tx.portalLinkChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  })

  if (challenge.ambiguous) throw ambiguousIdentifier()
  if (!challenge.tutorId) throw invalidCode()

  const tutor = await tx.tutor.findFirst({
    where: { id: challenge.tutorId, anonymizedAt: null, deletedAt: null },
    select: { id: true, portalUserId: true },
  })
  if (!tutor) throw invalidCode()

  if (tutor.portalUserId && tutor.portalUserId !== userId) {
    await recordSecurityEvent({
      tenantId: actor.tenantId,
      type: 'LOGIN_FAILED',
      targetEntity: 'tutor',
      targetId: tutor.id,
      ipAddress: actor.ipAddress ?? null,
      metadata: { reason: 'PORTAL_TAKEOVER_ATTEMPT' },
    })
    throw alreadyLinked()
  }

  await tx.tutor.update({
    where: { id: tutor.id },
    data: {
      portalUserId: userId,
      portalLinkedAt: tutor.portalUserId ? undefined : new Date(),
      portalLastSeenAt: new Date(),
    },
  })

  await recordAudit(tx, {
    tenantId: actor.tenantId,
    actorUserId: userId,
    action: 'portal.linked',
    entity: 'tutor',
    entityId: tutor.id,
    after: { channel: challenge.channel, challengeId: challenge.id },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  })

  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: actor.tenantId },
    select: { slug: true },
  })

  return { tutorId: tutor.id, channel: challenge.channel, slug: tenant.slug }
}

/**
 * O endereço do Portal deste petshop, para o link das boas-vindas.
 *
 * Montado do `APP_DOMAIN` em tempo de execução, e não de uma constante: o mesmo motivo
 * pelo qual o frontend lê o domínio do ambiente em vez de embuti-lo no build — a imagem
 * não pode nascer amarrada a uma instalação.
 */
function portalUrlOf(slug: string): string {
  const domain = loadEnv().APP_DOMAIN
  const protocol = domain.startsWith('localhost') ? 'http' : 'https'
  return domain.startsWith('localhost')
    ? `${protocol}://${domain}/portal`
    : `${protocol}://${slug}.${domain}/portal`
}
