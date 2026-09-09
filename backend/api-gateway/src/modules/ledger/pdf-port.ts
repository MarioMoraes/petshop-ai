import { createPdfRenderer } from '@petshop/pdf'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * Geração de PDF (MOD-LEDGER-08), sobre o Gotenberg.
 *
 * A fiação é fina de propósito: o mecanismo mora em `@petshop/pdf` e o que fica aqui é
 * de onde vem a URL. O `DISABLE_EVENTS` é reaproveitado como chave de desligamento —
 * um ambiente sem broker é o mesmo ambiente de teste que não quer falar com o
 * Gotenberg, e criar uma segunda variável para dizer a mesma coisa só daria a alguém a
 * chance de configurá-las em desacordo.
 *
 * **É a terceira instância de `createPdfRenderer` no processo, e são três de
 * propósito** — as outras são `modules/terms/pdf-port.ts` e `modules/records/pdf-port.ts`.
 * Unificá-las em `shared/` faria o dublê de um módulo valer nos outros, e a suíte do
 * recibo passaria a depender do que a do receituário tivesse injetado por último.
 */

export const { renderPdf, setPdfPort, isConfigured: isPdfConfigured } = createPdfRenderer({
  getUrl: () => loadEnv().GOTENBERG_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
  logger,
})

export { PdfUnavailableError, escapeHtml } from '@petshop/pdf'
