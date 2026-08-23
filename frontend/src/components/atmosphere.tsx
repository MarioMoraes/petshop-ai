'use client'

import { useEffect, useRef } from 'react'

/**
 * Blooms atmosféricos (`design/design-modelo.html` §Atmosfera).
 *
 * Três `radial-gradient` em `blur-3xl`, e o detalhe que faz os três funcionarem: cada
 * um termina em **a cor da própria superfície com alpha zero**, nunca em
 * `transparent`. O navegador interpola `transparent` em direção a preto transparente,
 * e o resultado é uma franja acinzentada na borda do bloom.
 *
 * Por isso `surface` é parâmetro: o mesmo bloom sobre o shell (`#f4f5f5`) e sobre um
 * cartão (`#ffffff`) precisa de dois pontos de chegada diferentes.
 */

/** Superfícies onde um bloom pode pousar, com o alpha zero correspondente. */
const FADE_TO = {
  surface: 'rgba(244,245,245,0)',
  card: 'rgba(255,255,255,0)',
} as const

type Surface = keyof typeof FADE_TO

/**
 * Atmosfera da página inteira, com o parallax de ponteiro do hero do design.
 *
 * Só o bloom quente se move — os outros dois ficam parados de propósito. Mover os
 * três daria a sensação de a página inteira deslizar; mover um sozinho dá
 * profundidade, que é o efeito procurado.
 *
 * Precisa de um ancestral `relative`, e o conteúdo ao lado precisa de `relative z-10`:
 * elemento posicionado pinta por cima de bloco não posicionado, então sem isso os
 * blooms cobririam o texto.
 */
export function Atmosphere() {
  const warmBloom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // O design desliga o parallax na origem, e não apenas o encurta.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    function handlePointerMove(event: PointerEvent) {
      const x = (event.clientX / window.innerWidth - 0.5) * 24
      const y = (event.clientY / window.innerHeight - 0.5) * 24
      if (warmBloom.current) {
        warmBloom.current.style.transform = `translate(${x}px, ${y}px)`
      }
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    return () => window.removeEventListener('pointermove', handlePointerMove)
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div
        ref={warmBloom}
        className="absolute -right-40 top-0 h-[720px] w-[720px] rounded-full opacity-70 blur-3xl transition-transform duration-700 ease-out"
        style={{
          background: `radial-gradient(circle at 55% 45%, rgba(227,74,50,0.55), rgba(240,120,70,0.28) 40%, ${FADE_TO.surface} 70%)`,
        }}
      />
      {/* O frio no canto oposto ao quente: o calor puxa o olho para a direita. */}
      <div
        className="absolute -left-52 top-24 h-[640px] w-[640px] rounded-full opacity-60 blur-3xl"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(46,48,52,0.35), rgba(120,124,130,0.15) 72%)',
        }}
      />
      <div
        className="absolute -bottom-40 right-1 h-[420px] w-[560px] rounded-full opacity-40 blur-3xl"
        style={{
          background: `radial-gradient(circle at 50% 50%, rgba(227,74,50,0.25), ${FADE_TO.surface} 70%)`,
        }}
      />
    </div>
  )
}

/**
 * Bloom de canto para dentro de um cartão.
 *
 * Estático: o parallax é da atmosfera da página. Um cartão que também respondesse ao
 * ponteiro competiria com ela, e o olho perderia a referência de profundidade.
 *
 * Quem usa precisa de `relative overflow-hidden` no cartão — sem o recorte, o bloom
 * vaza pelos cantos arredondados.
 */
export function CardBloom({ surface = 'card' }: { surface?: Surface }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -right-8 -top-10 block h-40 w-40 rounded-full opacity-70 blur-3xl"
      style={{
        background: `radial-gradient(circle at 55% 45%, rgba(227,74,50,0.55), rgba(240,120,70,0.28) 40%, ${FADE_TO[surface]} 70%)`,
      }}
    />
  )
}
