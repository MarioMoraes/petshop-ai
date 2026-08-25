import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfRenderer, escapeHtml, PdfUnavailableError } from './index.js'

const logger = { error: vi.fn(), debug: vi.fn() }

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function renderer(url: string | undefined, disabled = false) {
  return createPdfRenderer({ getUrl: () => url, isDisabled: () => disabled, logger })
}

describe('degradação — o PDF é o que falha, não o serviço', () => {
  it('sem URL configurada, lança PdfUnavailableError', async () => {
    await expect(renderer(undefined).renderPdf('<p>oi</p>')).rejects.toThrow(PdfUnavailableError)
  })

  it('desabilitado, também lança — e não tenta a rede', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(renderer('http://gotenberg:3000', true).renderPdf('<p>oi</p>')).rejects.toThrow(
      PdfUnavailableError,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('`isConfigured` responde antes de tentar', () => {
    expect(renderer(undefined).isConfigured()).toBe(false)
    expect(renderer('http://gotenberg:3000', true).isConfigured()).toBe(false)
    expect(renderer('http://gotenberg:3000').isConfigured()).toBe(true)
  })

  it('resposta de erro do Gotenberg vira PdfUnavailableError com o detalhe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('HTML malformado', { status: 400 }),
    )

    await expect(renderer('http://gotenberg:3000').renderPdf('<p>')).rejects.toThrow(
      /respondeu 400.*HTML malformado/s,
    )
  })

  it('rede caída vira PdfUnavailableError, não o erro cru do fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(renderer('http://gotenberg:3000').renderPdf('<p>oi</p>')).rejects.toThrow(
      PdfUnavailableError,
    )
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('chamada ao Gotenberg', () => {
  it('manda o HTML como `index.html` e devolve os bytes', async () => {
    const bytes = Buffer.from('%PDF-1.4 fingido')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array(bytes), { status: 200 }))

    const result = await renderer('http://gotenberg:3000').renderPdf('<p>recibo</p>')

    expect(result.equals(bytes)).toBe(true)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://gotenberg:3000/forms/chromium/convert/html')
    expect(init.method).toBe('POST')

    const form = init.body as FormData
    const file = form.get('files') as File
    expect(file.name).toBe('index.html')
    expect(await file.text()).toBe('<p>recibo</p>')
    // A4 por padrão, sem o chamador precisar dizer.
    expect(form.get('paperWidth')).toBe('8.27')
  })

  it('a barra final da URL não duplica no caminho', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array(), { status: 200 }))

    await renderer('http://gotenberg:3000/').renderPdf('<p>oi</p>')
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://gotenberg:3000/forms/chromium/convert/html')
  })

  it('opções do chamador sobrescrevem o padrão', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array(), { status: 200 }))

    await renderer('http://gotenberg:3000').renderPdf('<p>oi</p>', { marginTop: 0 })

    const form = (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as FormData
    expect(form.get('marginTop')).toBe('0')
    expect(form.get('marginBottom')).toBe('0.6')
  })
})

describe('setPdfPort', () => {
  it('o dublê substitui o real, e `null` devolve o real', async () => {
    const pdf = renderer('http://gotenberg:3000')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    pdf.setPdfPort({ async render() { return Buffer.from('dublê') } })
    expect((await pdf.renderPdf('<p>oi</p>')).toString()).toBe('dublê')
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockResolvedValue(new Response(new Uint8Array(Buffer.from('real')), { status: 200 }))
    pdf.setPdfPort(null)
    expect((await pdf.renderPdf('<p>oi</p>')).toString()).toBe('real')
  })

  it('com dublê, `isConfigured` é verdadeiro mesmo sem URL', () => {
    const pdf = renderer(undefined)
    pdf.setPdfPort({ async render() { return Buffer.from('x') } })
    expect(pdf.isConfigured()).toBe(true)
  })
})

describe('escapeHtml', () => {
  it('neutraliza o que viraria execução dentro do Chromium do Gotenberg', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(escapeHtml('Ração "Premium" & cia')).toBe('Ração &quot;Premium&quot; &amp; cia')
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien')
  })

  it('deixa texto comum intacto, acentos incluídos', () => {
    expect(escapeHtml('Maria Conceição — Banho')).toBe('Maria Conceição — Banho')
  })
})
