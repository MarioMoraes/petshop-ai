import { createPdfRenderer } from '@petshop/pdf'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * Geração de PDF no Portal — hoje, só a cópia dos dados do titular (AC-04 de
 * MOD-PORTAL-09).
 *
 * **Quarta instância de `createPdfRenderer` no processo**, ao lado de `terms`, `records` e
 * `ledger`, e são quatro de propósito: unificá-las em `shared/` faria o dublê de um módulo
 * valer nos outros, e a suíte da cópia do titular passaria a depender do que a do recibo
 * tivesse injetado por último.
 *
 * **Por que o documento nasce aqui, e não no MOD-TUTOR.** O conteúdo é a exportação que
 * aquele módulo monta e audita; o que este acrescenta é a **folha** — o nome do petshop no
 * cabeçalho, o fuso em que as datas são lidas, a linguagem de quem escreve para o cliente e
 * não para a operação. Nada disso é do domínio do cadastro.
 */

export const { renderPdf, setPdfPort, isConfigured: isPdfConfigured } = createPdfRenderer({
  getUrl: () => loadEnv().GOTENBERG_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
  logger,
})

export { PdfUnavailableError, escapeHtml } from '@petshop/pdf'
