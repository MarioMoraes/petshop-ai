'use client'

import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { deveSinalizar } from '@/lib/navegacao'

/**
 * A barra de progresso do topo.
 *
 * Toda tela do Admin é `force-dynamic`: clicar num item do menu manda uma requisição e
 * espera o servidor montar a página inteira antes de qualquer pixel mudar. Sem barra, o
 * clique parece não ter acontecido — e a resposta de quem está no balcão é clicar de novo.
 *
 * Ela não substitui o esqueleto (`components/skeleton.tsx`), que só entra onde a moldura
 * já está montada e a troca é de conteúdo. A barra cobre o resto — inclusive a travessia
 * de uma seção para outra, em que o `AppShell` da seção de destino ainda nem existe.
 *
 * **Começo e fim vêm de lugares diferentes.** O App Router não publica evento de início
 * de navegação: `usePathname` só muda quando a resposta já chegou, que é o fim. O começo
 * é o clique, capturado no `document` (a regra de quais cliques contam está em
 * `lib/navegacao.ts`) ou anunciado à mão por `iniciarProgresso()` — o `router.push` que
 * nasce de um formulário, por exemplo.
 *
 * **Ela demora 140 ms para aparecer.** Navegação que resolve em 80 ms com a barra piscando
 * lê como defeito, não como resposta. E o teto de 88% é deliberado: barra que chega a 100%
 * e fica parada mente sobre o que falta.
 */

/** Quanto a barra espera antes de aparecer. Abaixo disso, o clique já foi respondido. */
const ATRASO = 140

/** Onde o avanço simulado para. O 100% é só do fim de verdade. */
const TETO = 88

/**
 * Desistência.
 *
 * `router.refresh()` e a navegação recusada pelo servidor não mudam o pathname, e sem
 * este prazo a barra ficaria pendurada no alto da tela pelo resto da sessão.
 */
const LIMITE = 20_000

/* ── O aviso de "comecei" ────────────────────────────────────────────────────
 *
 * Um contador em módulo, e não contexto de React: quem precisa acender a barra é quase
 * sempre um `startTransition` no meio de um handler, longe de qualquer provider — e um
 * provider a mais em três molduras para carregar um inteiro não se paga.
 */

let inicios = 0
const ouvintes = new Set<() => void>()

/**
 * Acende a barra para uma navegação que não nasce de um clique em link — o
 * `router.push` do fim de um formulário, o `router.replace` de um filtro.
 */
export function iniciarProgresso(): void {
  inicios += 1
  for (const ouvinte of ouvintes) ouvinte()
}

function inscrever(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte)
  return () => {
    ouvintes.delete(ouvinte)
  }
}

const ler = () => inicios

/** No servidor não há navegação em curso: a barra nasce apagada e hidrata apagada. */
const lerNoServidor = () => 0

/* ── O motor ─────────────────────────────────────────────────────────────────
 *
 * Fora do componente porque é só cronômetro: guardá-lo em `useRef` mantém os efeitos
 * com uma linha cada e sem dependência instável.
 */

interface Motor {
  iniciar: () => void
  encerrar: () => void
  parar: () => void
}

function criarMotor(aplicar: (largura: number | null) => void): Motor {
  let revelar: ReturnType<typeof setTimeout> | undefined
  let passo: ReturnType<typeof setInterval> | undefined
  let limite: ReturnType<typeof setTimeout> | undefined
  let some: ReturnType<typeof setTimeout> | undefined
  let largura = 0
  let rodando = false

  function definir(valor: number): void {
    largura = valor
    aplicar(valor)
  }

  function parar(): void {
    clearTimeout(revelar)
    clearInterval(passo)
    clearTimeout(limite)
    clearTimeout(some)
    revelar = passo = limite = some = undefined
  }

  function arrancar(de: number): void {
    definir(de)
    // Passo decrescente: anda rápido no começo, onde a maioria das navegações termina, e
    // vai encostando no teto. Passo constante encosta cedo demais e a barra parece travada.
    passo = setInterval(() => definir(largura + (TETO - largura) * 0.14), 220)
  }

  function encerrar(): void {
    parar()
    if (!rodando) return
    rodando = false
    definir(100)
    some = setTimeout(() => {
      largura = 0
      aplicar(null)
    }, 280)
  }

  function iniciar(): void {
    // Clique em cima de clique: a barra continua de onde estava, sem sumir e voltar.
    const anterior = rodando ? largura : null
    parar()
    rodando = true

    if (anterior === null) revelar = setTimeout(() => arrancar(8), ATRASO)
    else arrancar(anterior)

    limite = setTimeout(encerrar, LIMITE)
  }

  return { iniciar, encerrar, parar }
}

/* ── O componente ────────────────────────────────────────────────────────── */

/**
 * `useSearchParams` faz o Next exigir um limite de suspensão em volta — sem ele, a rota
 * que puder ser estática quebra no build. O `fallback` é nulo de propósito: uma barra de
 * progresso que precisasse de um esqueleto próprio seria piada pronta.
 */
export function RouteProgress() {
  return (
    <Suspense fallback={null}>
      <Barra />
    </Suspense>
  )
}

function Barra() {
  const inicio = useSyncExternalStore(inscrever, ler, lerNoServidor)
  const pathname = usePathname()
  const busca = useSearchParams().toString()

  const [largura, setLargura] = useState<number | null>(null)
  const motor = useRef<Motor | null>(null)
  motor.current ??= criarMotor(setLargura)

  useEffect(() => {
    document.addEventListener('click', aoClicar, true)
    window.addEventListener('popstate', aoVoltar)
    return () => {
      document.removeEventListener('click', aoClicar, true)
      window.removeEventListener('popstate', aoVoltar)
    }

    function aoClicar(evento: MouseEvent): void {
      const alvo = evento.target
      if (!(alvo instanceof Element)) return
      const link = alvo.closest('a')
      if (!link) return

      // `link.download` é o **valor** do atributo, e `<a download>` sem valor devolve
      // string vazia — que passaria por "não é download" se fosse lida como booleano.
      const clicado = {
        href: link.href,
        target: link.target,
        download: link.hasAttribute('download'),
      }

      if (deveSinalizar(clicado, window.location.href, evento)) iniciarProgresso()
    }

    function aoVoltar(): void {
      iniciarProgresso()
    }
  }, [])

  useEffect(() => {
    if (inicio > 0) motor.current?.iniciar()
  }, [inicio])

  // Chegou. Também roda na montagem, quando não há nada em curso e o motor devolve sem
  // fazer nada.
  useEffect(() => {
    motor.current?.encerrar()
  }, [pathname, busca])

  useEffect(() => () => motor.current?.parar(), [])

  if (largura === null) return null

  /*
   * `aria-hidden`: o Next já mantém um anunciador de rota que lê o título da página nova
   * para o leitor de tela. Uma segunda voz dizendo "carregando" a cada clique seria a
   * primeira coisa que alguém desligaria.
   */
  return (
    <div className="route-progress" aria-hidden="true">
      <span
        className="route-progress-bar"
        style={{ width: `${largura}%`, opacity: largura >= 100 ? 0 : 1 }}
      />
    </div>
  )
}
