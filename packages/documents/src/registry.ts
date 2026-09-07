import { createHash } from 'node:crypto'
import type { TenantTransaction } from '@petshop/db'
import {
  DOCUMENT_MAX_ATTEMPTS,
  documentRetentionUntil,
  formatDocumentNumber,
  type DocumentKind,
} from '@petshop/shared-types'

/**
 * O registro de `documents` (MOD-DOC-02 e MOD-DOC-03).
 *
 * Vive num pacote e não em cada serviço porque as operações são idênticas nos quatro
 * que vão emitir documento — alocar número, nascer pendente, marcar emitido, marcar
 * falho, achar o que reprocessar. Duplicá-las seria refazer a dívida que o
 * `service-kit` foi extraído para pagar.
 *
 * O que **não** mora aqui é o template: o miolo de cada documento continua no serviço
 * que sabe o que está imprimindo.
 */

/**
 * RN-16 — número sequencial por tenant, tipo e ano.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` numa instrução só: dois atendentes
 * emitindo no mesmo segundo pegam números diferentes sem trava explícita, porque o
 * Postgres serializa a atualização da mesma linha.
 *
 * Uma `CREATE SEQUENCE` seria o caminho óbvio e não serve: sequence é global, e uma por
 * tenant exigiria DDL em tempo de execução.
 */
export async function allocateNumber(
  tx: TenantTransaction,
  tenantId: string,
  kind: DocumentKind,
  year: number,
): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO document_counters (tenant_id, kind, year, last_number)
    VALUES (${tenantId}::uuid, ${kind}::"DocumentKind", ${year}, 1)
    ON CONFLICT (tenant_id, kind, year) DO UPDATE
       SET last_number = document_counters.last_number + 1
    RETURNING last_number
  `

  return formatDocumentNumber(kind, year, rows[0]?.last_number ?? 1)
}

export interface CreateDocumentInput {
  kind: DocumentKind
  tutorId?: string | null
  petId?: string | null
  createdBy?: string | null
  /** O ano da série. É a data do **fato**, não a de agora: recibo de 31/12 é do ano dele. */
  reference: Date
}

/**
 * Cria o documento pendente e consome o número.
 *
 * Roda **dentro** da transação que originou o documento, porque é o que a numeração
 * sequencial exige. O arquivo nasce depois, fora dela: gerar um documento envolve um
 * Chromium e uma ida ao bucket, e nada disso pode segurar a transação que está movendo
 * dinheiro — nem derrubá-la se falhar.
 */
export async function createPendingDocument(
  tx: TenantTransaction,
  tenantId: string,
  input: CreateDocumentInput,
): Promise<{ id: string; number: string }> {
  const number = await allocateNumber(tx, tenantId, input.kind, input.reference.getUTCFullYear())

  return tx.document.create({
    data: {
      tenantId,
      kind: input.kind,
      number,
      tutorId: input.tutorId ?? null,
      petId: input.petId ?? null,
      createdBy: input.createdBy ?? null,
    },
    select: { id: true, number: true },
  })
}

export function checksumOf(pdf: Buffer): string {
  return createHash('sha256').update(pdf).digest('hex')
}

/** O arquivo chegou: o documento vira `ISSUED` e a guarda começa a contar. */
export async function markIssued(
  tx: TenantTransaction,
  documentId: string,
  file: { storageKey: string; pdf: Buffer; issuedAt: Date },
): Promise<void> {
  await tx.document.update({
    where: { id: documentId },
    data: {
      status: 'ISSUED',
      storageKey: file.storageKey,
      checksum: checksumOf(file.pdf),
      sizeBytes: file.pdf.byteLength,
      issuedAt: file.issuedAt,
      retentionUntil: documentRetentionUntil(file.issuedAt),
      lastError: null,
      attempts: { increment: 1 },
    },
  })
}

/**
 * A tentativa falhou.
 *
 * Na décima o documento vai a `FAILED` e sai da fila (MOD-DOC-11): falha silenciosa em
 * documento com valor legal é a pior categoria de falha silenciosa, e um retry infinito
 * é justamente o que torna a falha silenciosa.
 */
export async function markAttemptFailed(
  tx: TenantTransaction,
  documentId: string,
  error: string,
): Promise<{ status: 'PENDING' | 'FAILED' }> {
  const updated = await tx.document.update({
    where: { id: documentId },
    data: { lastError: error.slice(0, 500), attempts: { increment: 1 } },
    select: { attempts: true },
  })

  if (updated.attempts < DOCUMENT_MAX_ATTEMPTS) return { status: 'PENDING' }

  await tx.document.update({ where: { id: documentId }, data: { status: 'FAILED' } })
  return { status: 'FAILED' }
}

/**
 * Cancelar mantém o arquivo e o número.
 *
 * O RN-04 é explícito: número de documento cancelado não volta para a série. Um buraco
 * na sequência é uma pergunta que o contador sabe responder; um número reaproveitado é
 * um documento duplicado que ele não sabe.
 */
export async function cancelDocument(
  tx: TenantTransaction,
  documentId: string,
): Promise<void> {
  await tx.document.updateMany({
    where: { id: documentId, status: { in: ['PENDING', 'ISSUED'] } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })
}
