import { describe, expect, it } from 'vitest'
import { jsonLdSeguro } from './json-ld.js'

/** Os dados estruturados do site público (AC-02 de MOD-SITE-10). */

describe('jsonLdSeguro', () => {
  it('não deixa o nome do estabelecimento fechar o <script>', () => {
    const saida = jsonLdSeguro({ name: 'Pet</script><script>alert(1)</script>' })

    expect(saida).not.toContain('<')
    expect(saida).not.toMatch(/<\/script/i)
  })

  it('não abre comentário HTML', () => {
    expect(jsonLdSeguro({ name: '<!-- x' })).not.toContain('<!--')
  })

  it('continua sendo o mesmo JSON para quem o lê', () => {
    const data = { '@type': 'PetStore', name: 'Banho & Tosa <Centro>', priceRange: 'R$ 50' }

    expect(JSON.parse(jsonLdSeguro(data))).toEqual(data)
  })
})
