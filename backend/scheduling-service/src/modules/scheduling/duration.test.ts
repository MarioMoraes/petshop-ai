import { describe, expect, it } from 'vitest'
import { applyCoatFactor, resolveItemDuration, roundToGrid, totalDuration } from './duration.js'

/**
 * RN-01. Testes puros: nenhuma dessas contas toca o banco, e todas decidem quanto
 * tempo o pet fica no petshop.
 */

describe('roundToGrid', () => {
  it('sempre arredonda para cima', () => {
    expect(roundToGrid(122)).toBe(135)
    expect(roundToGrid(46)).toBe(60)
    expect(roundToGrid(1)).toBe(15)
  })

  it('deixa quem já está na grade quieto', () => {
    expect(roundToGrid(120)).toBe(120)
    expect(roundToGrid(15)).toBe(15)
  })
})

describe('applyCoatFactor', () => {
  it('faz a conta do AC-01: 90 min de pelagem dupla vira 135', () => {
    // 90 × 1,35 = 121,5 → 135 na grade de 15.
    expect(applyCoatFactor(90, 1.35)).toBe(135)
  })

  it('pelagem curta (fator 1) não altera a duração do porte', () => {
    expect(applyCoatFactor(60, 1.0)).toBe(60)
  })

  it('pet sem pelagem cadastrada usa fator 1 — a ausência do dado não encurta nada', () => {
    expect(applyCoatFactor(60, null)).toBe(60)
    expect(applyCoatFactor(60, 0)).toBe(60)
  })
})

describe('resolveItemDuration', () => {
  it('banho e tosa sofrem o fator de pelagem', () => {
    expect(resolveItemDuration({ sizeDurationMin: 90, coatFactor: 1.35, category: 'BATH' })).toBe(135)
    expect(
      resolveItemDuration({ sizeDurationMin: 90, coatFactor: 1.35, category: 'GROOMING' }),
    ).toBe(135)
  })

  it('corte de unha e consulta ignoram a pelagem', () => {
    // Cortar unha de cão de pelo duplo leva o mesmo tempo que de pelo curto;
    // multiplicar ali inflaria a agenda por um dado irrelevante.
    expect(resolveItemDuration({ sizeDurationMin: 15, coatFactor: 1.5, category: 'OTHER' })).toBe(15)
    expect(resolveItemDuration({ sizeDurationMin: 30, coatFactor: 1.5, category: 'VET' })).toBe(30)
  })
})

describe('totalDuration', () => {
  it('soma os itens já arredondados, e não arredonda a soma', () => {
    // Dois banhos de 45 são 90, não 75: arredondar depois criaria um atendimento
    // que não cabe nos próprios itens.
    expect(totalDuration([45, 45])).toBe(90)
    expect(totalDuration([135, 15])).toBe(150)
  })

  it('lista vazia é zero', () => {
    expect(totalDuration([])).toBe(0)
  })
})
