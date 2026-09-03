import { withTenant, type TenantTransaction, type Tutor } from '@petshop/db'
import {
  CURRENT_TERMS_VERSION,
  TUTOR_ROUTING_KEYS,
  maskPhone,
  type AnonymizeTutorInput,
  type CreateTutorInput,
  type ListTutorsQuery,
  type PaginatedTutors,
  type TutorDetail,
  type TutorSensitive,
  type UpdateTutorInput,
} from '@petshop/shared-types'
import { randomBytes } from 'node:crypto'
import { recordAudit } from '../../lib/audit.js'
import {
  blockedByHistory,
  duplicateConflict,
  duplicateWarning,
  notFound,
  terminalState,
} from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import {
  CACHE_KEYS,
  CACHE_TTL_SECONDS,
  cacheDelete,
  cacheGet,
  cacheSet,
  invalidateTutor,
} from '../../lib/redis.js'
import { createAddressIn } from '../addresses/service.js'
import { recordConsentsIn } from '../consents/service.js'
import { hashCnpj, hashCpf, hashPhone, hashTutorEmail, openCipher } from './crypto.js'
import { findExactDocumentMatch, findProbableDuplicates, toSearchKeys } from './dedupe.js'
import { toTutorDetail, toTutorResponse, type TutorRow } from './mapper.js'
import { searchTutorIds } from './search.js'

/**
 * CRUD do tutor (MOD-TUTOR-01), exclusão e anonimização (MOD-TUTOR-08).
 *
 * Toda escrita roda em uma transação com contexto de tenant: cifragem, hashes,
 * consentimento e auditoria caem juntos ou não caem — um tutor gravado sem o registro
 * de consentimento seria exatamente o buraco que o módulo existe para tapar.
 */

/** Relação carregada em toda leitura de tutor. */
const WITH_TAGS = { tagAssignments: { include: { tag: true } } } as const

export interface ActorContext {
  tenantId: string
  actorUserId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function listTutors(
  tenantId: string,
  query: ListTutorsQuery,
): Promise<PaginatedTutors> {
  const startedAt = Date.now()

  const data = await withTenant(tenantId, async (tx) => {
    const { ids, total } = await searchTutorIds(tx, query)
    if (ids.length === 0) return { data: [], total, page: query.page, limit: query.limit }

    const rows = await tx.tutor.findMany({ where: { id: { in: ids } }, include: WITH_TAGS })
    const cipher = await openCipher(tx, tenantId)

    // `findMany` não preserva a ordem do `IN`; a relevância vem do SQL de busca.
    const byId = new Map(rows.map((row) => [row.id, row]))
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined)

    return {
      data: ordered.map((row) => toTutorResponse(row, cipher)),
      total,
      page: query.page,
      limit: query.limit,
    }
  })

  recordMetric({
    metric: 'tutor_search_latency',
    tenantId,
    value: Date.now() - startedAt,
    unit: 'ms',
  })
  return data
}

export async function getTutor(tenantId: string, tutorId: string): Promise<TutorDetail> {
  const cached = await cacheGet<TutorDetail>(CACHE_KEYS.tutor(tenantId, tutorId))
  if (cached) return cached

  const detail = await withTenant(tenantId, async (tx) => {
    const row = await tx.tutor.findFirst({
      where: { id: tutorId, deletedAt: null },
      include: WITH_TAGS,
    })
    if (!row) throw notFound()

    const [addresses, consents, cipher] = await Promise.all([
      tx.tutorAddress.findMany({ where: { tutorId }, orderBy: [{ isPrimary: 'desc' }] }),
      tx.tutorConsent.findMany({ where: { tutorId }, orderBy: { createdAt: 'asc' } }),
      openCipher(tx, tenantId),
    ])

    return toTutorDetail(row, cipher, addresses, consents)
  })

  await cacheSet(CACHE_KEYS.tutor(tenantId, tutorId), detail, CACHE_TTL_SECONDS.tutor)
  return detail
}

/**
 * Campos completos, sem máscara. Cada chamada é auditada como `tutor.cpf_revealed`
 * (PRD §9): a exibição do CPF inteiro é evento, não detalhe de tela.
 */
export async function revealTutorData(
  actor: ActorContext,
  tutorId: string,
): Promise<TutorSensitive> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!row) throw notFound()
      if (row.status === 'ANONYMIZED') throw terminalState('Cadastro anonimizado')

      const cipher = await openCipher(tx, actor.tenantId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.cpf_revealed',
        entity: 'tutor',
        entityId: tutorId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        cpf: row.cpfEncrypted ? cipher.decrypt(row.cpfEncrypted) : null,
        cnpj: row.cnpjEncrypted ? cipher.decrypt(row.cnpjEncrypted) : null,
        phone: cipher.decrypt(row.phoneEncrypted),
        phoneAlt: row.phoneAltEncrypted ? cipher.decrypt(row.phoneAltEncrypted) : null,
        email: row.emailEncrypted ? cipher.decrypt(row.emailEncrypted) : null,
      }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )
}

// ─── Criação ─────────────────────────────────────────────────────────────────

export async function createTutor(
  actor: ActorContext,
  input: CreateTutorInput,
): Promise<TutorDetail> {
  const detail = await withTenant(
    actor.tenantId,
    async (tx) => {
      const cipher = await openCipher(tx, actor.tenantId)

      const cpfHash = input.cpf ? hashCpf(input.cpf) : undefined
      const cnpjHash = input.cnpj ? hashCnpj(input.cnpj) : undefined

      await assertNoDocumentDuplicate(tx, actor.tenantId, { cpfHash, cnpjHash })

      if (!input.duplicateAcknowledged) {
        await warnOnProbableDuplicate(tx, actor.tenantId, input)
      }

      const phoneHash = hashPhone(input.phone)

      const created = await tx.tutor.create({
        data: {
          tenantId: actor.tenantId,
          personType: input.personType,
          fullName: input.fullName,
          socialName: input.socialName ?? null,
          legalName: input.legalName ?? null,
          cpfEncrypted: input.cpf ? cipher.encrypt(input.cpf) : null,
          cpfHash: cpfHash ?? null,
          cnpjEncrypted: input.cnpj ? cipher.encrypt(input.cnpj) : null,
          cnpjHash: cnpjHash ?? null,
          phoneEncrypted: cipher.encrypt(input.phone),
          phoneHash,
          phoneAltEncrypted: input.phoneAlt ? cipher.encrypt(input.phoneAlt) : null,
          phoneAltHash: input.phoneAlt ? hashPhone(input.phoneAlt) : null,
          emailEncrypted: input.email ? cipher.encrypt(input.email) : null,
          emailHash: input.email ? hashTutorEmail(input.email) : null,
          birthDate: input.birthDate ? new Date(input.birthDate) : null,
          notes: input.notes ?? null,
          status: 'ACTIVE',
          dataCompleteness: completenessOf({
            hasDocument: Boolean(input.cpf ?? input.cnpj),
            hasAddress: Boolean(input.address),
          }),
          createdBy: actor.actorUserId ?? null,
        },
        include: WITH_TAGS,
      })

      if (input.address) {
        await createAddressIn(tx, cipher, {
          tenantId: actor.tenantId,
          tutorId: created.id,
          // O primeiro endereço é sempre o principal, independente do que veio.
          input: { ...input.address, isPrimary: true },
        })
      }

      await recordConsentsIn(tx, {
        tenantId: actor.tenantId,
        tutorId: created.id,
        transitions: consentTransitionsFrom(input),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.created',
        entity: 'tutor',
        entityId: created.id,
        after: { fullName: created.fullName, personType: created.personType },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      if (input.duplicateAcknowledged) {
        // PRD §9: ignorar o alerta de duplicata é ação auditável por si só.
        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'tutor.duplicate_override',
          entity: 'tutor',
          entityId: created.id,
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })
      }

      const [addresses, consents] = await Promise.all([
        tx.tutorAddress.findMany({ where: { tutorId: created.id } }),
        tx.tutorConsent.findMany({ where: { tutorId: created.id }, orderBy: { createdAt: 'asc' } }),
      ])

      return toTutorDetail(created, cipher, addresses, consents)
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await publishEvent(TUTOR_ROUTING_KEYS.tutorCriado, {
    tenantId: actor.tenantId,
    tutorId: detail.id,
    phone: input.phone,
    hasWhatsappConsent: input.consents.whatsapp,
  })
  recordMetric({ metric: 'tutor_created_total', tenantId: actor.tenantId, value: 1, unit: 'count' })
  if (input.duplicateAcknowledged) {
    recordMetric({
      metric: 'tutor_duplicate_override_total',
      tenantId: actor.tenantId,
      value: 1,
      unit: 'count',
    })
  }

  await invalidateTutor(actor.tenantId, detail.id, [hashPhone(input.phone)])
  return detail
}

// ─── Atualização ─────────────────────────────────────────────────────────────

export async function updateTutor(
  actor: ActorContext,
  tutorId: string,
  patch: UpdateTutorInput,
): Promise<TutorDetail> {
  const changedFields = Object.keys(patch).filter((key) => key !== 'duplicateAcknowledged')
  if (changedFields.length === 0) return getTutor(actor.tenantId, tutorId)

  const { detail, phoneHashes } = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!before) throw notFound()
      assertWritable(before)

      const cipher = await openCipher(tx, actor.tenantId)

      const cpfHash = patch.cpf === undefined ? undefined : patch.cpf ? hashCpf(patch.cpf) : null
      const cnpjHash =
        patch.cnpj === undefined ? undefined : patch.cnpj ? hashCnpj(patch.cnpj) : null

      if (cpfHash || cnpjHash) {
        await assertNoDocumentDuplicate(
          tx,
          actor.tenantId,
          { cpfHash: cpfHash ?? undefined, cnpjHash: cnpjHash ?? undefined },
          tutorId,
        )
      }

      const updated = await tx.tutor.update({
        where: { id: tutorId },
        data: {
          ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
          ...(patch.socialName !== undefined ? { socialName: patch.socialName } : {}),
          ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
          ...(patch.cpf !== undefined
            ? { cpfEncrypted: patch.cpf ? cipher.encrypt(patch.cpf) : null, cpfHash }
            : {}),
          ...(patch.cnpj !== undefined
            ? { cnpjEncrypted: patch.cnpj ? cipher.encrypt(patch.cnpj) : null, cnpjHash }
            : {}),
          ...(patch.phone !== undefined
            ? { phoneEncrypted: cipher.encrypt(patch.phone), phoneHash: hashPhone(patch.phone) }
            : {}),
          ...(patch.phoneAlt !== undefined
            ? {
                phoneAltEncrypted: patch.phoneAlt ? cipher.encrypt(patch.phoneAlt) : null,
                phoneAltHash: patch.phoneAlt ? hashPhone(patch.phoneAlt) : null,
              }
            : {}),
          ...(patch.email !== undefined
            ? {
                emailEncrypted: patch.email ? cipher.encrypt(patch.email) : null,
                emailHash: patch.email ? hashTutorEmail(patch.email) : null,
              }
            : {}),
          ...(patch.birthDate !== undefined
            ? { birthDate: patch.birthDate ? new Date(patch.birthDate) : null }
            : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          updatedBy: actor.actorUserId ?? null,
        },
        include: WITH_TAGS,
      })

      const addressCount = await tx.tutorAddress.count({ where: { tutorId } })
      const completeness = completenessOf({
        hasDocument: Boolean(updated.cpfHash ?? updated.cnpjHash),
        hasAddress: addressCount > 0,
      })
      const withCompleteness =
        completeness === updated.dataCompleteness
          ? updated
          : await tx.tutor.update({
              where: { id: tutorId },
              data: { dataCompleteness: completeness },
              include: WITH_TAGS,
            })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.updated',
        entity: 'tutor',
        entityId: tutorId,
        // O diff sai com a PII redigida pelo `sanitize`: interessa *que* mudou.
        before: pick(before, changedFields),
        after: pick(withCompleteness, changedFields),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const [addresses, consents] = await Promise.all([
        tx.tutorAddress.findMany({ where: { tutorId }, orderBy: [{ isPrimary: 'desc' }] }),
        tx.tutorConsent.findMany({ where: { tutorId }, orderBy: { createdAt: 'asc' } }),
      ])

      return {
        detail: toTutorDetail(withCompleteness, cipher, addresses, consents),
        phoneHashes: [before.phoneHash, withCompleteness.phoneHash],
      }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId, phoneHashes)
  await publishEvent(TUTOR_ROUTING_KEYS.tutorAtualizado, {
    tenantId: actor.tenantId,
    tutorId,
    changedFields,
  })
  if (patch.status === 'INACTIVE') {
    await publishEvent(TUTOR_ROUTING_KEYS.tutorInativado, {
      tenantId: actor.tenantId,
      tutorId,
      lastAttendanceAt: detail.lastAttendanceAt,
    })
  }

  return detail
}

/** AC-04 de MOD-TUTOR-02: reativar em vez de duplicar. */
export async function reactivateTutor(
  actor: ActorContext,
  tutorId: string,
): Promise<TutorDetail> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.tutor.findFirst({ where: { id: tutorId } })
      if (!row) throw notFound()
      assertWritable(row)

      await tx.tutor.update({
        where: { id: tutorId },
        data: { status: 'ACTIVE', deletedAt: null, updatedBy: actor.actorUserId ?? null },
      })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.reactivated',
        entity: 'tutor',
        entityId: tutorId,
        before: { status: row.status, deletedAt: row.deletedAt },
        after: { status: 'ACTIVE', deletedAt: null },
        ipAddress: actor.ipAddress ?? null,
      })
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)
  return getTutor(actor.tenantId, tutorId)
}

// ─── Acesso ao Portal (MOD-PORTAL-01, RN-05) ─────────────────────────────────

/**
 * Desfaz o vínculo entre a ficha e um login do Portal.
 *
 * **É a única saída para um vínculo errado**, e por isso precisa existir junto da fatia
 * que cria vínculos. O AC-04 de MOD-PORTAL-01 recusa a segunda conta sobre a mesma
 * ficha, e a recusa é definitiva: quem entrou com o telefone certo de outra pessoa —
 * um número reciclado pela operadora é o caso realista — só sai daqui.
 *
 * O evento é o que faz a revogação valer **agora**, e não quando o cache de 60s do
 * gateway vencer (AC-05 de MOD-PORTAL-02).
 */
export async function unlinkPortalAccess(
  actor: ActorContext,
  tutorId: string,
): Promise<TutorDetail> {
  const previous = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!row) throw notFound()
      if (!row.portalUserId) return null

      await tx.tutor.update({
        where: { id: tutorId },
        data: {
          portalUserId: null,
          portalLinkedAt: null,
          updatedBy: actor.actorUserId ?? null,
        },
      })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'portal.unlinked',
        entity: 'tutor',
        entityId: tutorId,
        before: { portalUserId: row.portalUserId },
        after: { portalUserId: null },
        ipAddress: actor.ipAddress ?? null,
      })

      return row.portalUserId
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  if (previous) {
    // Antes do evento, e não por ele: o gateway não consome broker, e o que revoga a
    // sessão agora é esta chave sumir (AC-05 de MOD-PORTAL-02).
    await cacheDelete(CACHE_KEYS.portalSession(actor.tenantId, previous))

    await publishEvent('tutor.portal_desvinculado', {
      tenantId: actor.tenantId,
      tutorId,
      reason: 'EQUIPE',
      actorId: actor.actorUserId ?? null,
    })
  }

  await invalidateTutor(actor.tenantId, tutorId)
  return getTutor(actor.tenantId, tutorId)
}

// ─── Exclusão e anonimização (MOD-TUTOR-08) ──────────────────────────────────

export async function deleteTutor(actor: ActorContext, tutorId: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!row) throw notFound()
      assertWritable(row)
      await assertNoBlockingHistory(tx, row)

      await tx.tutor.update({
        where: { id: tutorId },
        data: { deletedAt: new Date(), status: 'INACTIVE', updatedBy: actor.actorUserId ?? null },
      })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.deleted',
        entity: 'tutor',
        entityId: tutorId,
        ipAddress: actor.ipAddress ?? null,
      })
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)
}

/**
 * AC-03: anonimização irreversível (LGPD art. 18).
 *
 * Apaga — não mascara — CPF, e-mail, telefone e endereço. O `tutor_id` continua
 * referenciado pelos lançamentos financeiros, que precisam sobreviver 5 anos por
 * obrigação fiscal (RN-07); o que some é o vínculo com a pessoa.
 *
 * `tutor_consents` é preservado: é prova de conformidade com retenção própria, e
 * apagá-lo destruiria justamente a defesa do tenant perante a ANPD.
 */
export async function anonymizeTutor(
  actor: ActorContext,
  tutorId: string,
  input: AnonymizeTutorInput,
): Promise<void> {
  const phoneHashes = await withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.tutor.findFirst({ where: { id: tutorId } })
      if (!row) throw notFound()
      if (row.anonymizedAt) throw terminalState('Este cadastro já foi anonimizado')
      if (row.status === 'MERGED') {
        throw terminalState('Cadastro mesclado — anonimize o cadastro de destino')
      }
      await assertNoFutureAppointments(tx, row)

      const anonymousName = `Tutor Anonimizado #${randomBytes(2).toString('hex').toUpperCase()}`

      await tx.tutorAddress.deleteMany({ where: { tutorId } })

      await tx.tutor.update({
        where: { id: tutorId },
        data: {
          fullName: anonymousName,
          socialName: null,
          legalName: null,
          cpfEncrypted: null,
          cpfHash: null,
          cnpjEncrypted: null,
          cnpjHash: null,
          // O telefone é NOT NULL: some o valor, some o hash — o registro deixa de
          // ser encontrável por qualquer canal.
          phoneEncrypted: '',
          phoneHash: '',
          phoneAltEncrypted: null,
          phoneAltHash: null,
          emailEncrypted: null,
          emailHash: null,
          birthDate: null,
          notes: null,
          portalUserId: null,
          status: 'ANONYMIZED',
          anonymizedAt: new Date(),
          updatedBy: actor.actorUserId ?? null,
        },
      })

      // Os pets não são tocados daqui: `tutor.anonimizado` é consumido pelo
      // pet-service, que encerra os vínculos e promove o responsável seguinte. O
      // histórico clínico fica com o animal (RN-09), e escrever em `pet_tutors` a
      // partir daqui furaria a fronteira entre os dois módulos.

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.anonymized',
        entity: 'tutor',
        entityId: tutorId,
        after: { anonymousName, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return [row.phoneHash, row.phoneAltHash].filter((hash): hash is string => Boolean(hash))
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId, phoneHashes)
  await publishEvent(TUTOR_ROUTING_KEYS.tutorAnonimizado, { tenantId: actor.tenantId, tutorId })
  recordMetric({
    metric: 'tutor_anonymized_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })
}

// ─── Regras compartilhadas ───────────────────────────────────────────────────

/** RN: `MERGED` e `ANONYMIZED` rejeitam qualquer escrita com 409 (PRD §6). */
export function assertWritable(row: Pick<Tutor, 'status'>): void {
  if (row.status === 'MERGED') {
    throw terminalState('Este cadastro foi unificado a outro e não aceita alterações')
  }
  if (row.status === 'ANONYMIZED') {
    throw terminalState('Este cadastro foi anonimizado e não aceita alterações')
  }
}

async function assertNoDocumentDuplicate(
  tx: TenantTransaction,
  tenantId: string,
  keys: { cpfHash?: string | undefined; cnpjHash?: string | undefined },
  excludeTutorId?: string,
): Promise<void> {
  const existing = await findExactDocumentMatch(tx, { ...keys, excludeTutorId })
  if (!existing) return

  const cipher = await openCipher(tx, tenantId)
  recordMetric({ metric: 'tutor_duplicate_blocked_total', tenantId, value: 1, unit: 'count' })

  // AC-04: quando o existente está inativo, a ação sugerida é reativar — nunca
  // criar um segundo cadastro e partir o histórico ao meio.
  const suggestedAction = existing.status === 'ACTIVE' ? 'OPEN_EXISTING' : 'REACTIVATE_EXISTING'

  throw duplicateConflict(
    existing.status === 'ACTIVE'
      ? 'Já existe um tutor com este documento neste estabelecimento'
      : 'Existe um cadastro inativo com este documento. Reative-o para preservar o histórico.',
    {
      id: existing.id,
      fullName: existing.fullName,
      phoneMasked: maskPhone(cipher.decrypt(existing.phoneEncrypted)),
      status: existing.status,
      suggestedAction,
    },
  )
}

/**
 * Duplicata provável não bloqueia — mas o cliente precisa ter visto o alerta.
 * Sem `duplicateAcknowledged`, devolve 409 com os candidatos; a UI mostra, o
 * atendente decide, e o segundo POST vem com o flag e é auditado.
 */
async function warnOnProbableDuplicate(
  tx: TenantTransaction,
  tenantId: string,
  input: CreateTutorInput,
): Promise<void> {
  const result = await findProbableDuplicates(
    tx,
    tenantId,
    toSearchKeys({
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
    }),
  )

  const relevant = result.candidates.filter((candidate) => candidate.confidence !== 'LOW')
  if (relevant.length === 0) return

  throw duplicateWarning(
    'Encontramos cadastros parecidos. Confirme se não é a mesma pessoa antes de salvar.',
    { candidates: relevant, confidence: result.confidence },
  )
}

/**
 * AC-02 e AC-04: histórico financeiro ou agenda futura bloqueiam a exclusão.
 * Enquanto MOD-LEDGER e MOD-AGENDA não existem, o saldo denormalizado é o que há —
 * e ele já é escrito pelo consumidor de `lancamento.criado`.
 */
async function assertNoBlockingHistory(tx: TenantTransaction, row: Tutor): Promise<void> {
  if (row.balanceCents !== 0) {
    throw blockedByHistory(
      'Este tutor possui histórico financeiro e não pode ser excluído. Você pode anonimizar os dados pessoais mantendo o histórico contábil.',
      { anonymizePath: `/v1/tutors/${row.id}/anonymize` },
    )
  }
  await assertNoFutureAppointments(tx, row)
}

/**
 * AC-04 de MOD-TUTOR-08: tutor com agendamento futuro não é excluído.
 *
 * A leitura é direta em `appointments`, sob RLS — o mesmo acoplamento assumido que o
 * tutor-service já tem com `pet_tutors`. A alternativa seria uma chamada HTTP ao
 * scheduling-service dentro da transação de exclusão, o que atrelaria a exclusão à
 * disponibilidade de outro serviço sem ganhar consistência nenhuma.
 *
 * "Futuro" é relativo a agora e só conta o que ainda ocupa lugar na agenda: um
 * agendamento já cancelado não impede exclusão nenhuma.
 */
async function assertNoFutureAppointments(tx: TenantTransaction, row: Tutor): Promise<void> {
  const future = await tx.appointment.findMany({
    where: {
      tutorId: row.id,
      startsAt: { gt: new Date() },
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] },
    },
    select: { id: true, startsAt: true, pet: { select: { name: true } } },
    orderBy: { startsAt: 'asc' },
    take: 20,
  })

  if (future.length === 0) return

  throw blockedByHistory(
    `Este tutor tem ${future.length} agendamento(s) futuro(s). Cancele-os antes de excluir o cadastro.`,
    {
      appointments: future.map((item) => ({
        id: item.id,
        startsAt: item.startsAt.toISOString(),
        petName: item.pet.name,
      })),
    },
  )
}

/**
 * COMPLETE exige o documento fiscal e um endereço — é o que um recibo precisa.
 * Sem isso o cadastro é PARTIAL e aparece no painel "Cadastros incompletos" (AC-03).
 */
export function completenessOf(input: {
  hasDocument: boolean
  hasAddress: boolean
}): 'COMPLETE' | 'PARTIAL' {
  return input.hasDocument && input.hasAddress ? 'COMPLETE' : 'PARTIAL'
}

function consentTransitionsFrom(input: CreateTutorInput) {
  return [
    { channel: 'TERMS' as const, granted: true, purpose: 'BOTH' as const },
    { channel: 'WHATSAPP' as const, granted: input.consents.whatsapp, purpose: 'MARKETING' as const },
    { channel: 'EMAIL' as const, granted: input.consents.email, purpose: 'MARKETING' as const },
    { channel: 'IMAGE_USE' as const, granted: input.consents.imageUse, purpose: 'MARKETING' as const },
  ].map((transition) => ({
    ...transition,
    source: 'STAFF_FORM' as const,
    version: CURRENT_TERMS_VERSION,
  }))
}

function pick(row: TutorRow | Tutor, keys: string[]): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}
