import { describe, expect, it } from 'vitest'
import {
  formatAddress,
  missingIssuerFields,
  renderDocument,
  renderPageFooter,
  type DocumentIssuer,
} from './layout.js'

const emissor: DocumentIssuer = {
  name: 'Petshop do João',
  legalName: 'João Comércio de Animais LTDA',
  cnpj: '12.345.678/0001-90',
  address: {
    zip: '01310100',
    street: 'Avenida Paulista',
    number: '1000',
    complement: 'sala 12',
    district: 'Bela Vista',
    city: 'São Paulo',
    state: 'SP',
  },
  phone: '(11) 3000-0000',
  logoUrl: null,
  primaryColor: '#2b6cb0',
}

describe('o cabeçalho de quem emitiu', () => {
  it('traz razão social, CNPJ, endereço e telefone', () => {
    const html = renderDocument({
      issuer: emissor,
      title: 'Recibo de pagamento',
      number: '2026/000001',
      issuedAt: new Date('2026-03-10T14:30:00Z'),
      timezone: 'America/Sao_Paulo',
      bodyHtml: '<p>miolo</p>',
    })

    expect(html).toContain('João Comércio de Animais LTDA')
    expect(html).toContain('CNPJ 12.345.678/0001-90')
    expect(html).toContain('Avenida Paulista, 1000')
    expect(html).toContain('CEP 01310-100')
    expect(html).toContain('(11) 3000-0000')
  })

  it('sem logo, o nome vira a marca — nunca uma imagem quebrada', () => {
    const html = renderDocument({
      issuer: emissor,
      title: 'Recibo de pagamento',
      number: '2026/000001',
      issuedAt: new Date(),
      timezone: 'America/Sao_Paulo',
      bodyHtml: '',
    })

    expect(html).not.toContain('<img')
    expect(html).toContain('Petshop do João')
  })

  it('a data de emissão sai no fuso do tenant, não no do servidor', () => {
    const meiaNoiteEmSP = new Date('2026-03-10T03:00:00Z')

    const html = renderDocument({
      issuer: emissor,
      title: 'Recibo',
      number: '2026/000001',
      issuedAt: meiaNoiteEmSP,
      timezone: 'America/Sao_Paulo',
      bodyHtml: '',
    })
    const emManaus = renderDocument({
      issuer: emissor,
      title: 'Recibo',
      number: '2026/000001',
      issuedAt: meiaNoiteEmSP,
      timezone: 'America/Manaus',
      bodyHtml: '',
    })

    expect(html).toContain('10/03/2026, 00:00')
    expect(emManaus).toContain('09/03/2026, 23:00')
  })

  it('escapa campo livre — o Gotenberg roda um Chromium de verdade', () => {
    const html = renderDocument({
      issuer: { ...emissor, name: '<script>alert(1)</script>' },
      title: 'Recibo',
      number: '2026/000001',
      issuedAt: new Date(),
      timezone: 'America/Sao_Paulo',
      bodyHtml: '',
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('o que falta para imprimir (AC-02 de MOD-DOC-01)', () => {
  it('emissor completo não acusa nada', () => {
    expect(missingIssuerFields(emissor)).toEqual([])
  })

  it('diz **qual** dado falta, não só que falta algo', () => {
    const semEndereco = missingIssuerFields({ ...emissor, address: null, phone: null })

    expect(semEndereco).toContain('endereço do estabelecimento')
    expect(semEndereco).toContain('telefone do estabelecimento')
  })
})

describe('o rodapé de página', () => {
  it('usa as marcas que só o Chromium do Gotenberg sabe preencher', () => {
    const html = renderPageFooter({ title: 'Recibo de pagamento', number: '2026/000001' })

    expect(html).toContain('class="pageNumber"')
    expect(html).toContain('class="totalPages"')
    expect(html).toContain('Recibo de Pagamento 2026/000001')
  })
})

describe('formatAddress', () => {
  it('formata o CEP com hífen e junta as partes na ordem do envelope', () => {
    expect(formatAddress(emissor.address!)).toBe(
      'Avenida Paulista, 1000 — sala 12 · Bela Vista · São Paulo/SP · CEP 01310-100',
    )
  })
})
