import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { titleCaseNode } from './title-case-node'

describe('titleCaseNode — o rótulo dos botões', () => {
  it('converte o rótulo de texto', () => {
    expect(titleCaseNode('Salvar alterações')).toBe('Salvar Alterações')
  })

  it('junta os pedaços antes de converter, para o conectivo do meio não subir', () => {
    expect(titleCaseNode(['Remover ', 'Rex', ' do pacote'])).toBe('Remover Rex do Pacote')
  })

  it('deixa o JSX intacto e converte só o texto ao lado dele', () => {
    const icone = createElement('svg', { key: 'i' })
    const [primeiro, segundo] = titleCaseNode([icone, 'baixar em PDF']) as unknown[]
    expect(primeiro).toMatchObject({ type: 'svg' })
    expect(segundo).toBe('Baixar em PDF')
  })
})
