import { describe, expect, it } from 'vitest'
import { senderWithName } from '../../src/modules/messaging/ports/email.js'

describe('senderWithName', () => {
  it('troca o nome da plataforma pelo do petshop', () => {
    expect(senderWithName('PetShop AI <contato@petshop.ai>', 'Pet da Ana')).toBe(
      '"Pet da Ana" <contato@petshop.ai>',
    )
  })

  it('põe o nome no endereço puro do domínio próprio', () => {
    expect(senderWithName('contato@petdaana.com.br', 'Pet da Ana')).toBe(
      '"Pet da Ana" <contato@petdaana.com.br>',
    )
  })

  it('sem nome, o endereço passa como veio', () => {
    expect(senderWithName('PetShop AI <contato@petshop.ai>', null)).toBe(
      'PetShop AI <contato@petshop.ai>',
    )
    expect(senderWithName('contato@petshop.ai', '  ')).toBe('contato@petshop.ai')
  })

  it('tira do nome a sintaxe do cabeçalho', () => {
    expect(senderWithName('contato@petshop.ai', 'Pet "<Top>"')).toBe(
      '"Pet Top" <contato@petshop.ai>',
    )
  })
})
