import type { Branding } from '@petshop/shared-types'

/**
 * A paleta da página, derivada da identidade que o petshop escolheu no onboarding.
 *
 * Nada aqui é escolha nova do admin: `branding` já existe, já é usado no Admin e no
 * Portal, e o site é a terceira superfície da mesma identidade (AC-01 de MOD-SITE-03).
 *
 * **O texto sobre a cor é calculado, não fixado.** Um petshop com identidade amarela
 * não pode receber um site com texto branco sobre amarelo (AC-04). A conta é a
 * luminância relativa da WCAG — a mesma que decide contraste —, e o limiar de 0,45 é
 * onde o preto passa a ganhar do branco em contraste sobre a cor.
 */

function channel(hex: string, start: number): number {
  const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return 0.5
  return (
    0.2126 * channel(clean, 0) + 0.7152 * channel(clean, 2) + 0.0722 * channel(clean, 4)
  )
}

/** Preto ou branco sobre a cor da marca — o que enxergar melhor. */
export function inkOn(hex: string): string {
  return relativeLuminance(hex) > 0.45 ? '#232427' : '#ffffff'
}

/** Mistura com o branco, para os fundos suaves derivados da cor da marca. */
function mixWithWhite(hex: string, amount: number): string {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return '#ffffff'

  const mixed = [0, 2, 4].map((start) => {
    const value = Number.parseInt(clean.slice(start, start + 2), 16)
    return Math.round(value + (255 - value) * amount)
  })

  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export interface SitePalette {
  brand: string
  onBrand: string
  /** Fundo de seção: a marca diluída, para a página não ser um bloco chapado. */
  tint: string
  /** Linha de 1px que dá silhueta ao que está sobre o tint. */
  line: string
  accent: string
}

export function paletteOf(branding: Branding): SitePalette {
  const brand = branding.primaryColor
  return {
    brand,
    onBrand: inkOn(brand),
    tint: mixWithWhite(brand, 0.94),
    line: mixWithWhite(brand, 0.82),
    accent: branding.secondaryColor ?? brand,
  }
}
