import { withTenant } from '@petshop/db'
import type {
  ImportBatch,
  ImportEntity,
  ImportOutcome,
  ImportReportRow,
} from '@petshop/shared-types'

/**
 * As duas tabelas do MOD-IMPORT — e **só** elas.
 *
 * Nenhum dado de domínio passa por aqui: tutor, pet, profissional e agendamento entram
 * pelas portas dos módulos donos, então a linha importada nasce com a mesma validação,
 * o mesmo evento e a mesma trilha da linha cadastrada à mão.
 */

interface BatchRow {
  id: string
  entity: string
  fileName: string
  rowCount: number
  createdCount: number
  updatedCount: number
  ignoredCount: number
  failedCount: number
  status: string
  createdAt: Date
  undoneAt: Date | null
}

function toBatch(row: BatchRow): ImportBatch {
  return {
    id: row.id,
    entity: row.entity as ImportEntity,
    fileName: row.fileName,
    rowCount: row.rowCount,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    ignoredCount: row.ignoredCount,
    failedCount: row.failedCount,
    status: row.status as ImportBatch['status'],
    createdAt: row.createdAt.toISOString(),
    undoneAt: row.undoneAt?.toISOString() ?? null,
  }
}

const BATCH_SELECT = {
  id: true,
  entity: true,
  fileName: true,
  rowCount: true,
  createdCount: true,
  updatedCount: true,
  ignoredCount: true,
  failedCount: true,
  status: true,
  createdAt: true,
  undoneAt: true,
} as const

export function listBatches(tenantId: string, limit = 50): Promise<ImportBatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.importBatch.findMany({
      select: BATCH_SELECT,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(toBatch)
  })
}

export function findBatch(tenantId: string, batchId: string): Promise<ImportBatch | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.importBatch.findFirst({ where: { id: batchId }, select: BATCH_SELECT })
    return row ? toBatch(row) : null
  })
}

/**
 * O lote mais recente **aplicado** com este hash de conteúdo, ou `null`.
 *
 * Serve ao aviso "este arquivo já foi aplicado em tal dia" — quem sobe duas vezes
 * precisa saber, senão conclui que a segunda carga criou tudo de novo. Lotes desfeitos
 * ficam de fora: o arquivo cujo lote foi desfeito é justamente o que se quer subir
 * outra vez.
 */
export function findAppliedByHash(
  tenantId: string,
  fileHash: string,
): Promise<{ id: string; createdAt: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.importBatch.findFirst({
      where: { fileHash, status: 'APLICADO' },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    return row ? { id: row.id, createdAt: row.createdAt.toISOString() } : null
  })
}

export interface NewBatch {
  entity: ImportEntity
  fileName: string
  fileHash: string
  mapping: Record<string, number>
  rowCount: number
  created: number
  updated: number
  ignored: number
  failed: number
  createdBy: string | null
  rows: ImportReportRow[]
}

/**
 * Grava o lote e as suas linhas numa transação.
 *
 * A transação é do **registro**, não da carga: as linhas de domínio já foram criadas
 * uma a uma antes de chegar aqui, cada uma com a sua própria. Fazer o contrário — uma
 * transação por lote — exigiria um caminho de escrita paralelo aos serviços dos
 * módulos, e o que se ganharia (tudo ou nada) já é resolvido pela idempotência:
 * reenviar o arquivo corrigido converge, porque o que entrou vira `IGNORADO` na segunda
 * passada.
 */
export function insertBatch(tenantId: string, batch: NewBatch): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const created = await tx.importBatch.create({
      data: {
        tenantId,
        entity: batch.entity,
        fileName: batch.fileName,
        fileHash: batch.fileHash,
        mapping: batch.mapping,
        rowCount: batch.rowCount,
        createdCount: batch.created,
        updatedCount: batch.updated,
        ignoredCount: batch.ignored,
        failedCount: batch.failed,
        createdBy: batch.createdBy,
      },
      select: { id: true },
    })

    if (batch.rows.length > 0) {
      // `createMany` e não uma escrita por linha: um lote de 5.000 linhas em 5.000 idas
      // ao banco prenderia uma conexão do pool por minutos, depois de a carga já ter
      // terminado.
      await tx.importRow.createMany({
        data: batch.rows.map((row) => ({
          tenantId,
          batchId: created.id,
          entity: batch.entity,
          lineNo: row.lineNo,
          ref: row.ref,
          outcome: row.outcome,
          entityId: row.entityId,
          message: row.message,
        })),
      })
    }

    return created.id
  })
}

/**
 * As linhas do lote, para o relatório. Sem teto: quem abre um lote antigo quer ver as
 * que falharam, e elas podem estar no fim.
 */
export function listRows(tenantId: string, batchId: string): Promise<ImportReportRow[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.importRow.findMany({
      where: { batchId },
      select: { lineNo: true, ref: true, outcome: true, message: true, entityId: true },
      orderBy: { lineNo: 'asc' },
    })
    return rows.map((row) => ({
      lineNo: row.lineNo,
      ref: row.ref,
      outcome: row.outcome as ImportOutcome,
      message: row.message,
      entityId: row.entityId,
    }))
  })
}

/** O que o lote CRIOU, na ordem inversa da criação — é o que o desfazer desmonta. */
export function listCreated(
  tenantId: string,
  batchId: string,
): Promise<{ entityId: string; ref: string | null }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.importRow.findMany({
      where: { batchId, outcome: 'CRIADO', entityId: { not: null } },
      select: { entityId: true, ref: true },
      orderBy: { lineNo: 'desc' },
    })
    return rows.map((row) => ({ entityId: row.entityId as string, ref: row.ref }))
  })
}

export function markUndone(tenantId: string, batchId: string): Promise<void> {
  return withTenant(tenantId, async (tx) => {
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'DESFEITO', undoneAt: new Date() },
    })
  })
}
