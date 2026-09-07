import { createPdfRenderer } from '@petshop/pdf'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Geração de PDF (MOD-DOC-04), sobre o Gotenberg.
 *
 * A fiação é fina de propósito: o mecanismo mora em `@petshop/pdf` e o que fica aqui é
 * de onde vem a URL. O `DISABLE_EVENTS` é reaproveitado como chave de desligamento —
 * um ambiente sem broker é o mesmo ambiente de teste que não quer falar com o
 * Gotenberg, e criar uma segunda variável para dizer a mesma coisa só daria a alguém a
 * chance de configurá-las em desacordo.
 *
 * Mesma forma do `billing-ledger-service/src/lib/pdf.ts`. As duas cabem em cinco linhas
 * porque o que é comum já foi extraído.
 */

export const { renderPdf, setPdfPort, isConfigured: isPdfConfigured } = createPdfRenderer({
  getUrl: () => loadEnv().GOTENBERG_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
  logger,
})

export { PdfUnavailableError, escapeHtml } from '@petshop/pdf'
