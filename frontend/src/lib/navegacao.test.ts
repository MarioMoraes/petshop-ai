import { describe, expect, it } from 'vitest'
import { deveSinalizar, type CliqueDeLink, type LinkClicado } from './navegacao.js'

/**
 * A tabela de recusa da barra de progresso.
 *
 * Cada caso aqui é uma vez em que a barra subiria sem ninguém estar esperando nada — e
 * uma barra que acende à toa é pior do que barra nenhuma.
 */

const ATUAL = 'https://petshop.example/tutores'

const CLIQUE: CliqueDeLink = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
}

function link(href: string, extra: Partial<LinkClicado> = {}): LinkClicado {
  return { href, target: '', download: false, ...extra }
}

describe('deveSinalizar', () => {
  it('acende no clique comum para outra rota do app', () => {
    expect(deveSinalizar(link('https://petshop.example/agenda/dia'), ATUAL, CLIQUE)).toBe(true)
  })

  it('acende quando só a busca muda — é uma ida ao servidor', () => {
    expect(deveSinalizar(link('https://petshop.example/tutores?page=2'), ATUAL, CLIQUE)).toBe(true)
  })

  it('recusa o clique que alguém já tratou', () => {
    const clique = { ...CLIQUE, defaultPrevented: true }
    expect(deveSinalizar(link('https://petshop.example/agenda/dia'), ATUAL, clique)).toBe(false)
  })

  it.each([
    ['Cmd/Ctrl', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
  ])('recusa %s + clique, que abre noutro lugar', (_nome, modificador) => {
    const clique = { ...CLIQUE, ...modificador }
    expect(deveSinalizar(link('https://petshop.example/agenda/dia'), ATUAL, clique)).toBe(false)
  })

  it('recusa o botão do meio', () => {
    const clique = { ...CLIQUE, button: 1 }
    expect(deveSinalizar(link('https://petshop.example/agenda/dia'), ATUAL, clique)).toBe(false)
  })

  it('recusa link que abre em outra aba', () => {
    const alvo = link('https://petshop.example/agenda/dia', { target: '_blank' })
    expect(deveSinalizar(alvo, ATUAL, CLIQUE)).toBe(false)
  })

  it('aceita o `_self` explícito, que é a aba de sempre', () => {
    const alvo = link('https://petshop.example/agenda/dia', { target: '_self' })
    expect(deveSinalizar(alvo, ATUAL, CLIQUE)).toBe(true)
  })

  it('recusa download — a tela nem se mexe', () => {
    const alvo = link('https://petshop.example/recibo.pdf', { download: true })
    expect(deveSinalizar(alvo, ATUAL, CLIQUE)).toBe(false)
  })

  it('recusa outro domínio, onde quem pinta o carregamento é o navegador', () => {
    expect(deveSinalizar(link('https://outro.example/x'), ATUAL, CLIQUE)).toBe(false)
  })

  it.each(['mailto:contato@petshop.example', 'tel:+5511999999999', 'javascript:void(0)'])(
    'recusa o protocolo %s',
    (href) => {
      expect(deveSinalizar(link(href), ATUAL, CLIQUE)).toBe(false)
    },
  )

  it('recusa href vazio', () => {
    expect(deveSinalizar(link(''), ATUAL, CLIQUE)).toBe(false)
  })

  it('recusa a própria rota', () => {
    expect(deveSinalizar(link(ATUAL), ATUAL, CLIQUE)).toBe(false)
  })

  it('recusa âncora interna, que só rola a página', () => {
    expect(deveSinalizar(link(`${ATUAL}#observacoes`), ATUAL, CLIQUE)).toBe(false)
  })
})
