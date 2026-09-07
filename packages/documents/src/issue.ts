import { withTenant } from '@petshop/db'
import { PdfUnavailableError, type PdfOptions } from '@petshop/pdf'
import type { DocumentKind } from '@petshop/shared-types'
import { renderPageFooter, renderPageHeader } from './layout.js'
import { markAttemptFailed, markIssued } from './registry.js'
import { documentKey, StorageUnavailableError, type DocumentStorage } from './storage.js'

/**
 * Renderizar, arquivar, marcar (MOD-DOC-02).
 *
 * O ciclo tem duas fases de propósito. O **número** nasce dentro da transação que
 * originou o documento, porque é o que a numeração sequencial exige. O **arquivo** nasce
 * aqui, fora dela: gerar um PDF envolve um Chromium e uma ida ao bucket, e nada disso
 * pode segurar a transação que está movendo dinheiro — nem derrubá-la se falhar.
 *
 * Daí `PENDING`: o fato entrou, o documento existe e tem número, e o arquivo chega
 * quando chegar. O job de reprocesso cuida do resto (RN-07).
 */

export interface IssueDocumentInput {
  tenantId: string
  documentId: string
  kind: DocumentKind
  /** O miolo, montado por quem sabe o que está imprimindo. */
  html: string
  /** Vai no rodapé de toda página, com a paginação. */
  title: string
  number: string
  pdfOptions?: PdfOptions
}

export interface IssueDocumentDeps {
  renderPdf: (html: string, options?: PdfOptions) => Promise<Buffer>
  storage: DocumentStorage
  logger: {
    warn: (payload: Record<string, unknown>, message: string) => void
    error: (payload: Record<string, unknown>, message: string) => void
  }
  /** Opções extras da transação — é onde o serviço passa o seu `tenantOptions`. */
  tenantOptions?: Parameters<typeof withTenant>[2]
}

export interface IssueDocumentResult {
  issued: boolean
  status: 'ISSUED' | 'PENDING' | 'FAILED'
  storageKey?: string
  pdf?: Buffer
}

export async function issueDocument(
  deps: IssueDocumentDeps,
  input: IssueDocumentInput,
): Promise<IssueDocumentResult> {
  /**
   * AC-05 — documento arquivado é imutável.
   *
   * A guarda é sobre o **documento**, não sobre o assunto dele. O chamador já costuma
   * checar o próprio estado (o recibo confere `receipts.status`), mas os dois podem
   * divergir: se a escrita do assunto falhar depois do arquivamento, o job volta aqui
   * com o assunto pendente e o documento já emitido. Sem esta guarda, a segunda passada
   * renderizaria de novo e **sobrescreveria** o arquivo que a pessoa já recebeu.
   */
  const existente = await withTenant(
    input.tenantId,
    (tx) =>
      tx.document.findUnique({
        where: { id: input.documentId },
        select: { status: true, storageKey: true },
      }),
    deps.tenantOptions,
  )

  if (existente?.status === 'ISSUED') {
    return {
      issued: false,
      status: 'ISSUED',
      storageKey: existente.storageKey ?? undefined,
    }
  }

  try {
    const pdf = await deps.renderPdf(input.html, {
      ...input.pdfOptions,
      headerHtml: renderPageHeader(),
      footerHtml: renderPageFooter({ title: input.title, number: input.number }),
      // Com rodapé, a margem de baixo precisa reservar o espaço dele: sem isso o
      // Gotenberg desenha a paginação por cima da última linha do conteúdo.
      marginBottom: input.pdfOptions?.marginBottom ?? 0.8,
    })

    const key = documentKey(input.tenantId, input.documentId)
    await deps.storage.get().put(key, pdf, 'application/pdf')

    await withTenant(
      input.tenantId,
      (tx) => markIssued(tx, input.documentId, { storageKey: key, pdf, issuedAt: new Date() }),
      deps.tenantOptions,
    )

    return { issued: true, status: 'ISSUED', storageKey: key, pdf }
  } catch (error) {
    // Infra fora do ar é esperado e vira `warn`; o resto é bug e vira `error`.
    const esperado = error instanceof PdfUnavailableError || error instanceof StorageUnavailableError
    const mensagem = error instanceof Error ? error.message : String(error)

    const outcome = await withTenant(
      input.tenantId,
      (tx) => markAttemptFailed(tx, input.documentId, mensagem),
      deps.tenantOptions,
    ).catch(() => ({ status: 'PENDING' as const }))

    deps.logger[esperado ? 'warn' : 'error'](
      { err: error, documentId: input.documentId, kind: input.kind, number: input.number },
      outcome.status === 'FAILED'
        ? 'documento desistiu depois de dez tentativas'
        : 'documento continua pendente',
    )

    return { issued: false, status: outcome.status }
  }
}
