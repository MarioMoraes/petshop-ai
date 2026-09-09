import { withTenant, type TenantTransaction } from '@petshop/db'
import type { PortalTimelineEntry, PortalTimelineResponse } from '@petshop/shared-types'
import { notFound } from './errors.js'
import { signPhotoUrl, variantKey } from './photo-urls.js'
import { openCipher } from './crypto.js'

/**
 * MOD-PORTAL-04 — o histórico do pet.
 *
 * A tela que justifica o módulo: é a pergunta "quando foi o último banho?" respondida
 * sem ligação. Tudo o mais é consequência disso.
 *
 * Três exclusões governam este arquivo, e as três acontecem **na consulta**, não na
 * montagem da resposta:
 *
 * - `DRAFT` não sai. Atendimento em andamento é a equipe trabalhando; mostrá-lo daria
 *   ao tutor um registro que ainda vai mudar, e a primeira versão é a que ele lembra.
 * - Nota `INTERNAL` não sai (AC-02). "Tutor discutiu o preço, atenção no próximo" é
 *   conversa da equipe entre si, e o `where` do Prisma é quem garante isso — filtrar no
 *   front significaria a nota ter viajado pela rede até o celular de quem ela cita.
 * - Motivo de anulação não sai (AC-03). O atendimento anulado **aparece**, marcado: o
 *   tutor viu o pet ir ao petshop naquele dia, e negar isso destruiria a confiança na
 *   tela inteira. O porquê interno é outra coisa.
 */

/** O que o tutor pode ver de um atendimento. `DRAFT` fica de fora. */
const VISIBLE_STATUSES = ['COMPLETED', 'VOIDED'] as const

export async function readOwnPetTimeline(
  tenantId: string,
  tutorId: string,
  petId: string,
  options: { cursor?: string; limit: number },
): Promise<PortalTimelineResponse> {
  return withTenant(tenantId, async (tx) => {
    await assertLinked(tx, tutorId, petId)

    /**
     * Uma linha a mais que o pedido: é ela que diz se há próxima página, sem um
     * `count` sobre a tabela inteira. O cursor é o `startedAt` da última entrega, e a
     * ordem é decrescente — o índice `(tenant_id, pet_id, started_at DESC)` do
     * MOD-PRONT serve esta consulta sem ordenação em memória.
     */
    const rows = await tx.attendance.findMany({
      where: {
        petId,
        status: { in: [...VISIBLE_STATUSES] },
        ...(options.cursor ? { startedAt: { lt: new Date(options.cursor) } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: options.limit + 1,
      select: {
        id: true,
        type: true,
        startedAt: true,
        finishedAt: true,
        performedBy: true,
        weightKg: true,
        voidedAt: true,
        items: { select: { label: true }, orderBy: { createdAt: 'asc' } },
        notes: {
          where: { visibility: 'TUTOR_VISIBLE' },
          select: { bodyEncrypted: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    const page = rows.slice(0, options.limit)
    const nextCursor = rows.length > options.limit ? last(page)?.startedAt.toISOString() ?? null : null

    const [cipher, professionals, photos] = await Promise.all([
      openCipher(tx, tenantId),
      professionalNames(
        tx,
        page.map((row) => row.performedBy),
      ),
      resultPhotos(
        tx,
        page.map((row) => row.id),
      ),
    ])

    const entries: PortalTimelineEntry[] = page.map((row) => ({
      id: row.id,
      type: row.type,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      professional: professionals.get(row.performedBy) ?? null,
      services: row.items.map((item) => item.label),
      notes: row.notes.map((note) => cipher.decrypt(note.bodyEncrypted)),
      photoUrls: photos.get(row.id) ?? [],
      weightKg: row.weightKg === null ? null : Number(row.weightKg),
      voidedAt: row.voidedAt?.toISOString() ?? null,
    }))

    return { entries, nextCursor }
  })
}

/**
 * O vínculo, conferido antes de qualquer leitura do prontuário.
 *
 * Separado da consulta do histórico porque a resposta é diferente: pet de outro tutor é
 * **404** (RN-03), e não uma linha do tempo vazia. Uma lista vazia responderia
 * "este pet existe e nunca foi atendido" a quem não deveria saber sequer que ele existe.
 */
async function assertLinked(
  tx: TenantTransaction,
  tutorId: string,
  petId: string,
): Promise<void> {
  const link = await tx.petTutor.findFirst({
    where: { tutorId, petId, unlinkedAt: null, pet: { deletedAt: null } },
    select: { id: true },
  })
  if (!link) throw notFound()
}

/**
 * O nome de quem atendeu.
 *
 * Só o nome: quem executou o banho é informação de serviço prestado, e o tutor tem
 * direito a ela. Cargo, agenda e contato do profissional não são — nada disso sai daqui.
 */
async function professionalNames(
  tx: TenantTransaction,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()

  const rows = await tx.professional.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

/**
 * As fotos do resultado (MOD-PRONT-10).
 *
 * `attendancePhase = AFTER` apenas: o "antes" é registro de estado que a equipe tira
 * para se proteger — o nó no pelo, a orelha inflamada —, e devolvê-lo ao tutor numa
 * galeria sem contexto lê como acusação. O "depois" é o que ele pagou para ver.
 */
async function resultPhotos(
  tx: TenantTransaction,
  attendanceIds: string[],
): Promise<Map<string, string[]>> {
  if (attendanceIds.length === 0) return new Map()

  const rows = await tx.petPhoto.findMany({
    where: { attendanceId: { in: attendanceIds }, attendancePhase: 'AFTER', deletedAt: null },
    select: { attendanceId: true, variants: true },
    orderBy: { takenAt: 'asc' },
  })

  const byAttendance = new Map<string, string[]>()
  await Promise.all(
    rows.map(async (row) => {
      if (!row.attendanceId) return
      const url = await signPhotoUrl(variantKey(row.variants, 'medium'))
      if (!url) return
      const list = byAttendance.get(row.attendanceId) ?? []
      list.push(url)
      byAttendance.set(row.attendanceId, list)
    }),
  )
  return byAttendance
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1]
}
