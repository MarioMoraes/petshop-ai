import { describe, expect, it } from 'vitest'
import { parseTermBody } from './terms.js'

describe('parseTermBody — títulos', () => {
  it('sobe o título em Title Case, e só o título', () => {
    const blocks = parseTermBody('# Da guarda do pet\n\nO tutor autoriza a guarda do pet.')

    expect(blocks).toEqual([
      { type: 'heading', spans: [{ text: 'Da Guarda do Pet', bold: false }] },
      {
        type: 'paragraph',
        spans: [{ text: 'O tutor autoriza a guarda do pet.', bold: false }],
      },
    ])
  })

  it('converte a frase inteira e devolve o negrito nos mesmos limites', () => {
    const [heading] = parseTermBody('## Das **condições de** pagamento')

    expect(heading).toEqual({
      type: 'heading',
      spans: [
        { text: 'Das ', bold: false },
        { text: 'Condições de', bold: true },
        { text: ' Pagamento', bold: false },
      ],
    })
  })
})
