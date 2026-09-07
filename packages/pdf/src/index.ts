/**
 * `@petshop/pdf` — HTML vira PDF, e nada mais.
 *
 * O PRD chama isto de MOD-DOC e o SPEC o desenha como `document-service:3012`. O
 * serviço não nasce (PRD documentos_pdf_11 §MOD-DOC-01): um serviço central obrigaria
 * cada serviço de domínio a mandar por HTTP o payload clínico e financeiro que ele já
 * tem em mãos, para receber de volta um arquivo.
 *
 * A fronteira, desde a fatia 1 do MOD-DOC, é esta: **aqui mora o mecanismo** — falar com
 * o Gotenberg e degradar quando ele não responde. O registro, a numeração, o
 * armazenamento e o molde comum moram em `@petshop/documents`, que depende deste
 * pacote. O template de cada documento continua no serviço que sabe o que está
 * imprimindo.
 *
 * Como o `service-kit`, tudo aqui é **fábrica**: um pacote não pode chamar o `loadEnv()`
 * de um serviço, então o serviço passa `getUrl`/`isDisabled` e instancia no seu
 * `lib/pdf.ts`.
 */

/** Erro de infraestrutura de PDF. O serviço decide se isso é 502 ou espera de job. */
export class PdfUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PdfUnavailableError'
  }
}

export interface PdfOptions {
  /** Polegadas, como o Gotenberg espera. A4 retrato é o padrão. */
  paperWidth?: number
  paperHeight?: number
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number
  landscape?: boolean
  /**
   * Cabeçalho e rodapé de página, no formato que o Chromium do Gotenberg entende:
   * documentos HTML próprios, onde `.pageNumber` e `.totalPages` são preenchidos por
   * ele. É a única forma de ter paginação `n/N` — CSS de contador de página não
   * funciona no Chromium headless, e um "página 1 de 3" calculado na aplicação exigiria
   * saber a altura do conteúdo antes de renderizá-lo.
   *
   * Ficam dentro da margem: com rodapé, `marginBottom` precisa reservar espaço, senão o
   * Gotenberg o desenha por cima do texto.
   */
  headerHtml?: string
  footerHtml?: string
}

export interface PdfPort {
  render(html: string, options?: PdfOptions): Promise<Buffer>
}

export interface PdfLogger {
  error: (payload: Record<string, unknown>, message: string) => void
  debug: (payload: Record<string, unknown>, message: string) => void
}

export interface PdfConfig {
  /** Lido a cada chamada: `loadEnv()` é memoizado sob demanda e resetado em teste. */
  getUrl: () => string | undefined
  isDisabled: () => boolean
  logger: PdfLogger
  /** Teto da conversão. Um HTML que não renderiza em 30s não vai renderizar. */
  timeoutMs?: number
}

export interface PdfRenderer {
  renderPdf: PdfPort['render']
  /** Injeta um dublê. Usado pelos testes; nunca em produção. `null` volta ao real. */
  setPdfPort: (next: PdfPort | null) => void
  /** Há para onde mandar? A tela usa isto para não oferecer o que não funciona. */
  isConfigured: () => boolean
}

/** A4 em polegadas, com margem de 0,6" — cabe em qualquer impressora de balcão. */
const A4: Required<Omit<PdfOptions, 'landscape' | 'headerHtml' | 'footerHtml'>> = {
  paperWidth: 8.27,
  paperHeight: 11.69,
  marginTop: 0.6,
  marginBottom: 0.6,
  marginLeft: 0.6,
  marginRight: 0.6,
}

const DEFAULT_TIMEOUT_MS = 30_000

export function createPdfRenderer(config: PdfConfig): PdfRenderer {
  let port: PdfPort | null = null

  const gotenberg: PdfPort = {
    async render(html, options = {}) {
      const url = config.getUrl()
      // Degradação preguiçosa: o serviço sobe sem Gotenberg e só a emissão do documento
      // falha. Mesma escolha que o storage de mídia do MOD-PET fez com o R2.
      if (config.isDisabled() || !url) {
        throw new PdfUnavailableError('Geração de PDF não configurada neste ambiente')
      }

      const { headerHtml, footerHtml, ...page } = options
      const merged = { ...A4, ...page }
      const form = new FormData()
      // O Gotenberg exige que o arquivo principal se chame `index.html`.
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html')
      // E que cabeçalho e rodapé cheguem com estes nomes exatos — outro qualquer é
      // tratado como recurso do documento e nunca aparece na página.
      if (headerHtml) {
        form.append('files', new Blob([headerHtml], { type: 'text/html' }), 'header.html')
      }
      if (footerHtml) {
        form.append('files', new Blob([footerHtml], { type: 'text/html' }), 'footer.html')
      }
      for (const [key, value] of Object.entries(merged)) {
        form.append(key, String(value))
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      try {
        const response = await fetch(`${trimSlash(url)}/forms/chromium/convert/html`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        })

        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new PdfUnavailableError(
            `Gotenberg respondeu ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
          )
        }

        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        if (error instanceof PdfUnavailableError) throw error
        config.logger.error({ err: error }, 'falha ao gerar PDF')
        throw new PdfUnavailableError('Falha ao gerar o documento', { cause: error })
      } finally {
        clearTimeout(timer)
      }
    },
  }

  return {
    renderPdf: (html, options) => (port ?? gotenberg).render(html, options),
    setPdfPort(next: PdfPort | null): void {
      port = next
    },
    isConfigured: () => port !== null || (!config.isDisabled() && Boolean(config.getUrl())),
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * Escapa texto para dentro de HTML.
 *
 * O template do recibo interpola nome de tutor, descrição de serviço e observação de
 * balcão — todos campos livres. Sem escape, um tutor chamado `<script>` viraria
 * execução dentro do Chromium do Gotenberg, que é um navegador de verdade.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
