import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  TUTOR_ROUTING_KEYS,
  termKindForChannel,
  type ConsentChannel,
  type ConsentPurpose,
  type ConsentRecord,
  type ConsentSource,
  type ConsentStatus,
  type ConsentsResponse,
  type UpdateConsentsInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { blockedByConsent, notFound } from '../tutors/errors.js'
import { publishEvent } from '../../shared/events.js'
import { recordMetric } from '../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet, invalidateTutor } from '../../shared/redis.js'
import { assertTermVersionExists, currentTermVersions } from '../terms/service.js'
import { currentConsentState } from '../tutors/mapper.js'
import { assertWritable, type ActorContext } from '../tutors/service.js'

/**
 * Consentimento LGPD (MOD-TUTOR-04).
 *
 * A tabela é **append-only** por trigger no banco (RN-05): revogar grava uma linha
 * nova, nunca altera a anterior. O estado atual é derivado da última transição de
 * cada canal — e derivar, em vez de guardar, é o que torna impossível o estado
 * divergir da prova que ele resume.
 */

export interface ConsentTransition {
  channel: ConsentChannel
  granted: boolean
  purpose?: ConsentPurpose
  source?: ConsentSource
  version?: string
}

export interface RecordConsentsParams {
  tenantId: string
  tutorId: string
  transitions: ConsentTransition[]
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Grava dentro de uma transação já aberta — usado na criação do tutor.
 *
 * Desde o MOD-DOC-06, **toda** linha tem a versão conferida contra `term_versions`
 * (AC-03): prova de aceite sem documento aceito é o defeito que aquele módulo veio
 * corrigir, e não se recria ele por um caminho lateral. A versão que falta no payload é
 * resolvida aqui, pela vigente do tenant — o cliente não a manda, e não deve mandar.
 */
export async function recordConsentsIn(
  tx: TenantTransaction,
  params: RecordConsentsParams,
): Promise<void> {
  if (params.transitions.length === 0) return

  const vigentes = await currentTermVersions(params.tenantId)

  const linhas = await Promise.all(
    params.transitions.map(async (transition) => {
      const kind = termKindForChannel(transition.channel)
      const version = transition.version ?? vigentes[kind]
      await assertTermVersionExists(tx, kind, version)

      return {
        tenantId: params.tenantId,
        tutorId: params.tutorId,
        channel: transition.channel,
        granted: transition.granted,
        purpose: transition.purpose ?? 'MARKETING',
        source: transition.source ?? 'STAFF_FORM',
        version,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      }
    }),
  )

  await tx.tutorConsent.createMany({ data: linhas })
}

/**
 * O estado atual e o histórico inteiro (AC-03), nada sobrescrito.
 *
 * **O cache guarda só o histórico**, e o estado é derivado a cada leitura. O histórico é
 * imutável — a tabela é append-only —, mas a vigência não: publicar um termo novo muda o
 * estado de quem aceitou o antigo para `PENDING_RENEWAL` sem tocar em nenhuma linha de
 * consentimento. Guardar o estado pronto exigiria invalidar a chave de cada tutor da
 * base a cada publicação.
 */
export async function getConsents(
  tenantId: string,
  tutorId: string,
): Promise<ConsentsResponse> {
  const versions = await currentTermVersions(tenantId)
  const cached = await cacheGet<ConsentRecord[]>(CACHE_KEYS.consents(tenantId, tutorId))

  const history =
    cached ??
    (await withTenant(tenantId, async (tx) => {
      const tutor = await tx.tutor.findFirst({
        where: { id: tutorId, deletedAt: null },
        select: { id: true },
      })
      if (!tutor) throw notFound()

      const rows = await tx.tutorConsent.findMany({
        where: { tutorId },
        orderBy: { createdAt: 'asc' },
      })

      return rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        granted: row.granted,
        purpose: row.purpose,
        version: row.version,
        source: row.source,
        documentId: row.documentId,
        createdAt: row.createdAt.toISOString(),
      })) satisfies ConsentRecord[]
    }))

  if (!cached) {
    await cacheSet(CACHE_KEYS.consents(tenantId, tutorId), history, CACHE_TTL_SECONDS.consents)
  }

  return {
    current: currentConsentState(
      history.map((record) => ({ ...record, createdAt: new Date(record.createdAt) })),
      versions,
    ),
    history,
  }
}

export async function updateConsents(
  actor: ActorContext,
  tutorId: string,
  input: UpdateConsentsInput,
): Promise<ConsentsResponse> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const tutor = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!tutor) throw notFound()
      assertWritable(tutor)

      await recordConsentsIn(tx, {
        tenantId: actor.tenantId,
        tutorId,
        transitions: input.transitions,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      for (const transition of input.transitions) {
        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: transition.granted ? 'consent.granted' : 'consent.revoked',
          entity: 'tutor_consent',
          entityId: tutorId,
          after: { channel: transition.channel, purpose: transition.purpose },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })
      }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)

  // A mesma resolução que a gravação fez: o evento precisa dizer qual texto valia, e
  // quem sabe isso é o tenant, não o cliente que omitiu o campo.
  const vigentes = await currentTermVersions(actor.tenantId)

  for (const transition of input.transitions) {
    await publishEvent(
      transition.granted
        ? TUTOR_ROUTING_KEYS.tutorConsentimentoConcedido
        : TUTOR_ROUTING_KEYS.tutorConsentimentoRevogado,
      {
        tenantId: actor.tenantId,
        tutorId,
        channel: transition.channel,
        purpose: transition.purpose,
        version: transition.version ?? vigentes[termKindForChannel(transition.channel)],
      },
    )
  }

  return getConsents(actor.tenantId, tutorId)
}

/**
 * RN-06 — pode enviar por este canal?
 *
 * Comunicação **transacional** (confirmação e lembrete de um serviço que o próprio
 * tutor contratou) roda por execução de contrato e não depende de opt-in. Marketing
 * depende, e um opt-out revogado bloqueia com ERR_TUTOR_009.
 *
 * Exportada para MOD-CRM e MOD-NOTIF consultarem antes de enfileirar.
 */
export async function assertCanCommunicate(
  tenantId: string,
  tutorId: string,
  channel: ConsentChannel,
  purpose: ConsentPurpose,
): Promise<void> {
  if (purpose === 'TRANSACTIONAL') return

  const { current } = await getConsents(tenantId, tutorId)
  const state = current.find((item) => item.channel === channel)

  if (!state || !state.granted || state.state !== 'GRANTED') {
    recordMetric({
      metric: 'tutor_communication_suppressed_total',
      tenantId,
      value: 1,
      unit: 'count',
    })
    throw blockedByConsent(
      `O tutor não autorizou comunicação de marketing por ${channelLabel(channel)}`,
    )
  }
}

/** O estado de um canal, sem estourar — para quem só precisa decidir se envia. */
export function consentStateOf(
  consents: ConsentStatus[],
  channel: ConsentChannel,
): ConsentStatus | null {
  return consents.find((item) => item.channel === channel) ?? null
}

function channelLabel(channel: ConsentChannel): string {
  const labels: Record<ConsentChannel, string> = {
    WHATSAPP: 'WhatsApp',
    EMAIL: 'e-mail',
    SMS: 'SMS',
    TERMS: 'termos de uso',
    SERVICE_LIABILITY: 'termo de responsabilidade',
    IMAGE_USE: 'uso de imagem',
  }
  return labels[channel]
}
