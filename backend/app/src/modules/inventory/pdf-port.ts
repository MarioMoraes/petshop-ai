import { createPdfRenderer } from '@petshop/pdf'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * Geração de PDF do estoque (MOD-ESTOQUE-11), sobre o Gotenberg.
 *
 * Uma instância própria de `createPdfRenderer`, como as do razão, dos termos e do
 * prontuário, e pela mesma razão: o dublê que a suíte do estoque injeta não pode valer
 * para a do recibo. O `DISABLE_EVENTS` é a chave de desligamento, como nas outras três.
 */

export const { renderPdf, setPdfPort } = createPdfRenderer({
  getUrl: () => loadEnv().GOTENBERG_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
  logger,
})

export { PdfUnavailableError, escapeHtml } from '@petshop/pdf'
