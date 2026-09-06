import { createPdfRenderer } from '@petshop/pdf'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Geração de PDF no Portal — hoje, só a cópia dos dados do titular (AC-04 de
 * MOD-PORTAL-09).
 *
 * Fiação idêntica à do `billing-ledger-service`, e de propósito: o mecanismo mora em
 * `@petshop/pdf` e o que fica aqui é de onde vem a URL. O `DISABLE_EVENTS` é
 * reaproveitado como chave de desligamento — um ambiente sem broker é o mesmo ambiente
 * de teste que não quer falar com o Gotenberg.
 *
 * **Por que o documento nasce aqui, e não no `tutor-service`.** O conteúdo é a exportação
 * que aquele serviço monta e audita; o que este acrescenta é a **folha** — o nome do
 * petshop no cabeçalho, o fuso em que as datas são lidas, a linguagem de quem escreve
 * para o cliente e não para a operação. Nada disso é do domínio do cadastro, e pôr o
 * template lá faria o tutor-service passar a conhecer o Portal.
 */

export const { renderPdf, setPdfPort, isConfigured: isPdfConfigured } = createPdfRenderer({
  getUrl: () => loadEnv().GOTENBERG_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
  logger,
})

export { PdfUnavailableError, escapeHtml } from '@petshop/pdf'
