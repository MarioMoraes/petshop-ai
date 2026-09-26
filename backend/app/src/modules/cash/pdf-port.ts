import { createPdfRenderer } from '@petshop/pdf'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * Geração de PDF do caixa — o fechamento impresso.
 *
 * Uma instância própria de `createPdfRenderer`, como a do estoque e a do razão: o dublê
 * que a suíte do caixa injeta não pode valer para a do recibo.
 */

export const { renderPdf, setPdfPort } = createPdfRenderer({
  getUrl: () => loadEnv().GOTENBERG_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
  logger,
})

export { PdfUnavailableError, escapeHtml } from '@petshop/pdf'
