import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  cancelDocument,
  createPendingDocument,
  issueDocument,
  loadIssuer,
  missingIssuerFields,
} from '@petshop/documents'
import {
  DOCUMENT_MAX_ATTEMPTS,
  DOCUMENT_URL_TTL_SECONDS,
  PRESCRIBABLE_ATTENDANCE_TYPES,
  PRESCRIPTION_TITLE,
  formatCrmv,
  type CreatePrescriptionInput,
  type PrescriptionItem,
  type PrescriptionView,
  type VoidPrescriptionInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import {
  crmvRequired,
  documentDataMissing,
  immutable,
  invalid,
  notFound,
} from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { isPdfConfigured, renderPdf } from '../../lib/pdf.js'
import { documentStorage, getStorage } from '../../lib/storage.js'
import { tenantOptions, type ActorContext } from '../records/actor.js'
import { loadAlertSources, toPetAlerts } from '../records/alerts.js'
import { openCipher, type RecordCipher } from '../records/crypto.js'
import { renderPrescriptionHtml, type PrescriptionData } from './template.js'

/**
 * Receituário veterinário (MOD-DOC-04). Fecha o MOD-PRONT-07.
 *
 * O ciclo é o mesmo do recibo, e por isso a mecânica é a mesma peça: o **número** nasce
 * dentro da transação que registra a prescrição, porque é o que a numeração sequencial
 * exige; o **arquivo** nasce depois, fora dela, porque envolve um Chromium e uma ida ao
 * bucket. Daí `PENDING` — a prescrição existe e tem número, e o PDF chega quando chegar.
 *
 * Três coisas são próprias deste documento, e são o que este arquivo guarda:
 *
 * 1. **Quem assina é quem está logado**, e não quem conduziu o atendimento. Um sistema
 *    que deixasse o balcão emitir receituário em nome do veterinário estaria produzindo
 *    prova falsa — e o que a RN-05 do MOD-DOC guarda é a assinatura, não o registro.
 * 2. **O CRMV vai em snapshot.** O reprocesso pode renderizar o PDF dias depois, e o
 *    papel precisa dizer o que era verdade no dia (AC-03 de MOD-DOC-05).
 * 3. **Não há edição.** Nenhuma rota altera os itens: a janela de 24h do MOD-PRONT vale
 *    para o registro clínico, não para o papel que saiu pela porta. Corrigir é anular e
 *    emitir outra.
 */

const PRESCRIPTION_KIND = 'PRESCRIPTION' as const

// ─── Emissão ─────────────────────────────────────────────────────────────────

export async function createPrescription(
  actor: ActorContext,
  attendanceId: string,
  input: CreatePrescriptionInput,
): Promise<PrescriptionView> {
  const issuedAt = new Date()

  const criado = await withTenant(
    actor.tenantId,
    async (tx) => {
      const attendance = await tx.attendance.findFirst({
        where: { id: attendanceId },
        select: { id: true, petId: true, tutorId: true, type: true, status: true },
      })
      if (!attendance) throw notFound('Atendimento não encontrado')

      // Anular o atendimento estorna o débito e risca o registro. Pendurar um
      // receituário novo nele produziria documento com valor legal apontando para um
      // fato que o sistema já declarou inexistente.
      if (attendance.status === 'VOIDED') {
        throw immutable('Atendimento anulado não recebe receituário')
      }

      if (!(PRESCRIBABLE_ATTENDANCE_TYPES as readonly string[]).includes(attendance.type)) {
        throw invalid('Receituário só sai de atendimento veterinário')
      }

      const vet = await loadPrescriber(tx, actor)

      const { issuer, timezone } = await loadIssuer(tx, actor.tenantId)
      const faltando = missingIssuerFields(issuer)
      if (faltando.length > 0) {
        // AC-02 de MOD-DOC-01: a resposta diz **qual** dado falta. Tenants criados
        // antes de 2026-08-28 estão sem endereço, e é por aqui que eles descobrem.
        throw documentDataMissing(
          `Complete o cadastro do estabelecimento antes de emitir documentos: ${faltando.join(', ')}`,
        )
      }

      const cipher = await openCipher(tx, actor.tenantId)

      const document = await createPendingDocument(tx, actor.tenantId, {
        kind: PRESCRIPTION_KIND,
        tutorId: attendance.tutorId,
        petId: attendance.petId,
        createdBy: actor.actorUserId ?? null,
        reference: issuedAt,
      })

      const crmv = formatCrmv(vet.crmv, vet.crmvState)

      const prescription = await tx.prescription.create({
        data: {
          tenantId: actor.tenantId,
          petId: attendance.petId,
          attendanceId: attendance.id,
          vetId: vet.id,
          crmv,
          itemsEncrypted: cipher.encrypt(JSON.stringify(input.items)),
          instructionsEncrypted: input.instructions ? cipher.encrypt(input.instructions) : null,
          documentId: document.id,
          issuedAt,
          createdBy: actor.actorUserId ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'document.issued',
        entity: 'prescription',
        entityId: prescription.id,
        after: {
          kind: PRESCRIPTION_KIND,
          // `documentNumber`, e não `number`: `number` está na lista de chaves
          // sensíveis do `service-kit` (é o número do endereço) e chegaria à trilha
          // como `[redacted]` — justamente o dado que o §9 manda registrar.
          documentNumber: document.number,
          petId: attendance.petId,
          tutorId: attendance.tutorId,
          vetId: vet.id,
          crmv,
          itemCount: input.items.length,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const payload = await collectData(tx, {
        number: document.number,
        petId: attendance.petId,
        tutorId: attendance.tutorId,
        vetName: vet.displayName,
        crmv,
        items: input.items,
        instructions: input.instructions ?? null,
        issuedAt,
        issuer,
        timezone,
      })

      return {
        prescription,
        document,
        payload,
        tutorId: attendance.tutorId,
        vetName: vet.displayName,
        crmv,
      }
    },
    tenantOptions(actor),
  )

  const outcome = await renderAndArchive(actor, {
    documentId: criado.document.id,
    number: criado.document.number,
    payload: criado.payload,
  })

  await publishEvent('prescricao.emitida', {
    tenantId: actor.tenantId,
    prescriptionId: criado.prescription.id,
    documentId: criado.document.id,
    number: criado.document.number,
    petId: criado.prescription.petId,
    tutorId: criado.tutorId,
    vetId: criado.prescription.vetId,
  })
  recordMetric({
    metric: 'prescription_issued_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return {
    id: criado.prescription.id,
    attendanceId: criado.prescription.attendanceId,
    petId: criado.prescription.petId,
    number: criado.document.number,
    crmv: criado.crmv,
    vetId: criado.prescription.vetId,
    vetName: criado.vetName,
    items: criado.payload.items,
    instructions: criado.payload.instructions,
    issuedAt: criado.prescription.issuedAt.toISOString(),
    voidedAt: null,
    voidReason: null,
    documentStatus: outcome.status,
    url: outcome.storageKey ? await signedUrl(outcome.storageKey) : null,
  }
}

/**
 * Quem assina.
 *
 * O prescritor é o **profissional vinculado ao usuário autenticado**, e não o
 * `performed_by` do atendimento. São a mesma pessoa no caminho normal, e a diferença
 * importa justamente quando não são: um receituário emitido pelo balcão em nome do
 * veterinário que não está na sala é documento falso, e a permissão `record:write`
 * sozinha não distingue os dois.
 *
 * `professionals.user_id` é opcional — a agenda tem gente que trabalha sem conta no
 * sistema. Quem não tem conta ligada não prescreve, e é o resultado certo: não há como
 * provar quem está do outro lado.
 */
async function loadPrescriber(tx: TenantTransaction, actor: ActorContext) {
  if (!actor.actorUserId) {
    throw crmvRequired('Prescrição exige usuário identificado com registro no conselho')
  }

  const vet = await tx.professional.findFirst({
    where: { userId: actor.actorUserId, deletedAt: null, active: true },
    select: { id: true, displayName: true, crmv: true, crmvState: true },
  })

  if (!vet) {
    throw crmvRequired(
      'Prescrição exige um profissional com CRMV vinculado ao seu usuário. Cadastre-o em Agenda → Profissionais.',
    )
  }
  if (!vet.crmv || !vet.crmvState) {
    throw crmvRequired(`${vet.displayName} não tem CRMV cadastrado`)
  }

  return { ...vet, crmv: vet.crmv, crmvState: vet.crmvState }
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export interface PrescriptionFilter {
  petId?: string
  attendanceId?: string
}

/**
 * A lista **não** emite URL assinada.
 *
 * Abrir a aba do pet não é baixar o receituário dele, e a trilha do §9 registra
 * download — não navegação. Uma listagem que assinasse dez arquivos geraria dez linhas
 * de acesso que ninguém pediu e afogaria as que importam.
 */
export async function listPrescriptions(
  actor: ActorContext,
  filter: PrescriptionFilter,
): Promise<PrescriptionView[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.prescription.findMany({
      where: {
        ...(filter.petId ? { petId: filter.petId } : {}),
        ...(filter.attendanceId ? { attendanceId: filter.attendanceId } : {}),
      },
      include: PRESCRIPTION_INCLUDE,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })

    const cipher = await openCipher(tx, actor.tenantId)
    return rows.map((row) => toView(row, cipher, null))
  })
}

/**
 * O detalhe, com a URL do arquivo.
 *
 * Emitir a URL **é** o download (§9), e é aqui que a trilha registra quem pediu e de
 * onde. Se o PDF ainda não existir, tenta gerar na hora: quem clicou está esperando, e
 * o job de dez em dez minutos é a rede de segurança, não o caminho feliz.
 */
export async function getPrescription(
  actor: ActorContext,
  prescriptionId: string,
): Promise<PrescriptionView> {
  let carregado = await loadOne(actor.tenantId, prescriptionId)

  if (carregado.row.document?.status === 'PENDING' && isPdfConfigured()) {
    await issuePendingPrescription(actor, prescriptionId).catch((error: unknown) => {
      // Falhar aqui deixaria o veterinário sem ver a prescrição que ele acabou de
      // emitir. O documento continua pendente e a tela diz "em preparo".
      logger.warn({ err: error, prescriptionId }, 'falha ao emitir receituário sob demanda')
    })
    carregado = await loadOne(actor.tenantId, prescriptionId)
  }

  const { row, cipher } = carregado
  const storageKey = row.document?.storageKey ?? null

  if (storageKey) {
    await withTenant(
      actor.tenantId,
      (tx) =>
        recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'document.downloaded',
          entity: 'prescription',
          entityId: prescriptionId,
          after: { kind: PRESCRIPTION_KIND, documentNumber: row.document?.number ?? null },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        }),
      tenantOptions(actor),
    )
  }

  return toView(row, cipher, storageKey ? await signedUrl(storageKey) : null)
}

// ─── Anulação ────────────────────────────────────────────────────────────────

/**
 * Anular mantém o arquivo e o número (RN-03 e RN-04).
 *
 * O receituário anulado continua visível na linha do tempo, com o motivo: o tutor pode
 * já ter levado o papel à farmácia, e um documento que some do sistema é exatamente o
 * que impede reconstruir o que foi entregue.
 */
export async function voidPrescription(
  actor: ActorContext,
  prescriptionId: string,
  input: VoidPrescriptionInput,
): Promise<PrescriptionView> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const current = await tx.prescription.findFirst({
        where: { id: prescriptionId },
        include: PRESCRIPTION_INCLUDE,
      })
      if (!current) throw notFound('Receituário não encontrado')
      if (current.voidedAt) throw immutable('Este receituário já foi anulado')

      const updated = await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
          voidedAt: new Date(),
          voidReason: input.reason,
          voidedBy: actor.actorUserId ?? null,
        },
        include: PRESCRIPTION_INCLUDE,
      })

      if (current.documentId) await cancelDocument(tx, current.documentId)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'document.cancelled',
        entity: 'prescription',
        entityId: prescriptionId,
        before: { documentNumber: current.document?.number ?? null },
        after: { reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const cipher = await openCipher(tx, actor.tenantId)
      return toView(updated, cipher, null)
    },
    tenantOptions(actor),
  )
}

// ─── Reprocesso (MOD-DOC-11) ─────────────────────────────────────────────────

/**
 * Gera o PDF de uma prescrição que ficou pendente. Idempotente.
 *
 * `issueDocument` recusa renderizar sobre documento já `ISSUED`, então uma segunda
 * passada nunca sobrescreve o arquivo que a pessoa já recebeu.
 */
export async function issuePendingPrescription(
  actor: ActorContext,
  prescriptionId: string,
): Promise<{ status: string; issued: boolean }> {
  const data = await withTenant(actor.tenantId, async (tx) => {
    const row = await tx.prescription.findFirst({
      where: { id: prescriptionId },
      include: { ...PRESCRIPTION_INCLUDE, vet: { select: { displayName: true } } },
    })
    if (!row) throw notFound('Receituário não encontrado')
    if (!row.document || row.document.status !== 'PENDING') {
      return { status: row.document?.status ?? 'PENDING', payload: null, documentId: null }
    }

    const cipher = await openCipher(tx, actor.tenantId)
    const { issuer, timezone } = await loadIssuer(tx, actor.tenantId)

    const payload = await collectData(tx, {
      number: row.document.number,
      petId: row.petId,
      tutorId: row.document.tutorId ?? '',
      vetName: row.vet.displayName,
      // O snapshot do dia, e não o cadastro de agora: quem corrigiu o próprio registro
      // não reescreve o receituário que já assinou.
      crmv: row.crmv,
      items: decodeItems(cipher, row.itemsEncrypted),
      instructions: row.instructionsEncrypted ? cipher.decrypt(row.instructionsEncrypted) : null,
      issuedAt: row.issuedAt,
      issuer,
      timezone,
    })

    return { status: row.document.status, payload, documentId: row.document.id }
  })

  if (!data.payload || !data.documentId) return { status: data.status, issued: false }

  const outcome = await renderAndArchive(actor, {
    documentId: data.documentId,
    number: data.payload.number,
    payload: data.payload,
  })

  return { status: outcome.status, issued: outcome.status === 'ISSUED' }
}

interface PendingRow {
  id: string
  tenant_id: string
}

/**
 * O job de reprocesso: os receituários que o Gotenberg não conseguiu gerar na hora.
 *
 * A varredura sai de `documents`, e não de `prescriptions`, porque é lá que moram
 * `attempts` e `last_error` — e o orçamento de tentativas é do documento. O `JOIN` é o
 * caminho de volta ao assunto.
 *
 * Prescrição anulada fica de fora: gerar o PDF de um papel que já foi cancelado é
 * trabalho para produzir arquivo que ninguém deve receber.
 */
export async function retryPendingPrescriptions(
  now: Date = new Date(),
): Promise<{ issued: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<PendingRow[]>`
    SELECT p.id, p.tenant_id
      FROM prescriptions p
      JOIN documents d ON d.id = p.document_id
     WHERE d.status = 'PENDING'
       AND d.attempts < ${DOCUMENT_MAX_ATTEMPTS}
       AND p.voided_at IS NULL
       AND p.created_at <= ${now}
     ORDER BY p.created_at ASC
     LIMIT 200
  `

  let issued = 0
  for (const row of rows) {
    try {
      const result = await issuePendingPrescription({ tenantId: row.tenant_id }, row.id)
      if (result.issued) issued += 1
    } catch (error) {
      // Um receituário que não pôde ser emitido não derruba os outros 199.
      logger.error({ err: error, prescriptionId: row.id }, 'falha ao reprocessar receituário')
    }
  }

  return { issued }
}

// ─── Apoio ───────────────────────────────────────────────────────────────────

const PRESCRIPTION_INCLUDE = {
  document: { select: { id: true, number: true, status: true, storageKey: true, tutorId: true } },
  vet: { select: { displayName: true } },
} as const

type PrescriptionRow = {
  id: string
  attendanceId: string
  petId: string
  vetId: string
  crmv: string
  itemsEncrypted: string
  instructionsEncrypted: string | null
  issuedAt: Date
  voidedAt: Date | null
  voidReason: string | null
  vet: { displayName: string }
  document: { number: string; status: string; storageKey: string | null } | null
}

function toView(row: PrescriptionRow, cipher: RecordCipher, url: string | null): PrescriptionView {
  return {
    id: row.id,
    attendanceId: row.attendanceId,
    petId: row.petId,
    number: row.document?.number ?? '',
    crmv: row.crmv,
    vetId: row.vetId,
    vetName: row.vet.displayName,
    items: decodeItems(cipher, row.itemsEncrypted),
    instructions: row.instructionsEncrypted ? cipher.decrypt(row.instructionsEncrypted) : null,
    issuedAt: row.issuedAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    documentStatus: (row.document?.status ?? 'PENDING') as PrescriptionView['documentStatus'],
    url,
  }
}

/**
 * Os itens saem do banco como JSON cifrado.
 *
 * Um erro de decifragem ou de forma **não** derruba a leitura da lista: a prescrição
 * ainda tem número, data e prescritor, e é isso que a tela precisa para dizer que
 * existe. Devolver o array vazio com o erro no log é melhor que uma aba em branco.
 */
function decodeItems(cipher: RecordCipher, payload: string): PrescriptionItem[] {
  try {
    const parsed: unknown = JSON.parse(cipher.decrypt(payload))
    return Array.isArray(parsed) ? (parsed as PrescriptionItem[]) : []
  } catch (error) {
    logger.error({ err: error }, 'falha ao ler os itens do receituário')
    return []
  }
}

async function loadOne(tenantId: string, prescriptionId: string) {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.prescription.findFirst({
      where: { id: prescriptionId },
      include: PRESCRIPTION_INCLUDE,
    })
    if (!row) throw notFound('Receituário não encontrado')
    return { row, cipher: await openCipher(tx, tenantId) }
  })
}

async function signedUrl(storageKey: string): Promise<string | null> {
  try {
    return await getStorage().signedUrl(storageKey, DOCUMENT_URL_TTL_SECONDS)
  } catch (error) {
    // Sem endereço, a tela ainda mostra número, itens e data — mais útil que um 502.
    logger.error({ err: error, storageKey }, 'falha ao assinar URL do receituário')
    return null
  }
}

async function renderAndArchive(
  actor: ActorContext,
  input: { documentId: string; number: string; payload: PrescriptionData },
) {
  return issueDocument(
    {
      renderPdf,
      storage: documentStorage,
      logger,
      tenantOptions: tenantOptions(actor),
    },
    {
      tenantId: actor.tenantId,
      documentId: input.documentId,
      kind: PRESCRIPTION_KIND,
      html: renderPrescriptionHtml(input.payload),
      title: PRESCRIPTION_TITLE,
      number: input.number,
    },
  )
}

interface CollectInput {
  number: string
  petId: string
  tutorId: string
  vetName: string
  crmv: string
  items: PrescriptionItem[]
  instructions: string | null
  issuedAt: Date
  issuer: PrescriptionData['issuer']
  timezone: string
}

/** Junta o que o papel mostra. Uma consulta por relação, dentro da mesma transação. */
async function collectData(
  tx: TenantTransaction,
  input: CollectInput,
): Promise<PrescriptionData> {
  const [pet, tutor, sources] = await Promise.all([
    tx.pet.findFirstOrThrow({
      where: { id: input.petId },
      select: { name: true, species: { select: { label: true } }, breed: { select: { label: true } } },
    }),
    input.tutorId
      ? tx.tutor.findFirst({
          where: { id: input.tutorId },
          select: { fullName: true, socialName: true },
        })
      : Promise.resolve(null),
    loadAlertSources(tx, input.petId),
  ])

  return {
    number: input.number,
    issuer: input.issuer,
    timezone: input.timezone,
    petName: pet.name,
    speciesLabel: pet.species.label,
    breedLabel: pet.breed?.label ?? null,
    tutorName: tutor?.socialName ?? tutor?.fullName ?? 'Não informado',
    vetName: input.vetName,
    crmv: input.crmv,
    items: input.items,
    instructions: input.instructions,
    issuedAt: input.issuedAt,
    // RN-14: a alergia crítica vai em destaque no papel, sempre. Quem administra o
    // medicamento em casa não abre o sistema.
    criticalAlerts: toPetAlerts(sources)
      .filter((alert) => alert.severity === 'CRITICAL')
      .map((alert) => alert.label),
  }
}
