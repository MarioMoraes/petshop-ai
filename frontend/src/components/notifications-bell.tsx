'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { Pendencia, PendenciaKey } from '@/lib/pendencias'
import { BellIcon, GlobeIcon, WalletIcon, type IconTone } from './icons'

/**
 * O sino de pendências, ao lado do avatar.
 *
 * Mostra **o que precisa de alguém agora**, não um histórico de avisos: as linhas
 * vêm de consultas ao trabalho pendente (ver `lib/pendencias.ts`), então não há
 * "marcar como lido" — o número cai quando o trabalho é feito.
 *
 * Client component porque o painel abre e fecha; a **lista chega pronta do servidor**,
 * via props. Assim o browser não fala com o gateway (que ele nem alcança) e o
 * conteúdo não pisca a cada abertura.
 *
 * O contador é atualizado a cada navegação, que é quando o servidor remonta a
 * moldura. Não há polling de propósito: um sino que se atualiza sozinho a cada 30s
 * custaria uma consulta a três serviços por minuto por pessoa logada, para adiantar
 * um número que a próxima tela já traria.
 */

const ICONES: Record<PendenciaKey, { icon: React.ReactNode; tone: IconTone }> = {
  // O mesmo tom que o item de menu correspondente: o ícone é do domínio, não da
  // tela, e o olho liga o aviso ao lugar onde ele se resolve.
  leads: { icon: <GlobeIcon />, tone: 'icon-metric' },
  mensagens: { icon: <BellIcon />, tone: 'icon-brand' },
  inadimplentes: { icon: <WalletIcon />, tone: 'icon-money' },
}

export function NotificationsBell({ pendencias }: { pendencias: Pendencia[] }) {
  const [aberto, setAberto] = useState(false)
  const caixa = useRef<HTMLDivElement>(null)
  const gatilho = useRef<HTMLButtonElement>(null)

  const total = pendencias.reduce((soma, p) => soma + p.count, 0)

  useEffect(() => {
    if (!aberto) return

    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key !== 'Escape') return
      setAberto(false)
      // Escape devolve o foco ao sino: quem fechou pelo teclado ficaria com o foco no
      // corpo da página, e o próximo Tab recomeçaria do topo do documento.
      gatilho.current?.focus()
    }

    function aoApontar(evento: PointerEvent) {
      const alvo = evento.target as Node
      if (caixa.current?.contains(alvo) || gatilho.current?.contains(alvo)) return
      setAberto(false)
    }

    document.addEventListener('keydown', aoTeclar)
    // `pointerdown` e não `click`: fechar no clique deixaria o painel aberto durante
    // todo o arrasto de uma seleção de texto começada fora dele.
    document.addEventListener('pointerdown', aoApontar)
    return () => {
      document.removeEventListener('keydown', aoTeclar)
      document.removeEventListener('pointerdown', aoApontar)
    }
  }, [aberto])

  return (
    <div className="relative">
      <button
        ref={gatilho}
        type="button"
        onClick={() => setAberto((estava) => !estava)}
        aria-expanded={aberto}
        aria-haspopup="dialog"
        aria-label={
          total === 0
            ? 'Pendências: nada aguardando'
            : `Pendências: ${total} ${total === 1 ? 'item aguardando' : 'itens aguardando'}`
        }
        className="relative grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-ink"
      >
        <BellIcon />
        {total > 0 && (
          /*
           * O ponto é `aria-hidden`: o número já está no `aria-label` do botão, em
           * frase inteira. Anunciado duas vezes, o leitor de tela diria "3, Pendências:
           * 3 itens aguardando".
           */
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[11px] font-semibold leading-[18px] text-white ring-2 ring-surface"
          >
            {total > 9 ? '9+' : total}
          </span>
        )}
      </button>

      {aberto && (
        <div
          ref={caixa}
          role="dialog"
          aria-label="Pendências"
          /*
           * Duas ancoragens, e a de celular não é capricho. Ancorado só à direita do
           * sino, o painel de 20rem cresce para a **esquerda** — e num aparelho de
           * 390px ele começa fora da tela. O estrago é invisível: transbordo à
           * esquerda não gera barra de rolagem, então o conteúdo é simplesmente
           * cortado sem sinal nenhum.
           *
           * Abaixo de `sm` ele vira uma faixa presa às duas margens, que não tem como
           * não caber. De `sm` para cima volta a ser o popover ancorado no sino.
           */
          className="card fixed left-4 right-4 top-16 z-30 overflow-hidden p-0 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_20px_50px_-24px_rgba(35,36,39,0.35)] sm:absolute sm:left-auto sm:right-0 sm:top-11 sm:w-80"
        >
          <p className="border-b border-line px-4 py-3 text-sm font-semibold">Pendências</p>

          {pendencias.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">
              Nada precisa de você agora.
            </p>
          ) : (
            <ul>
              {pendencias.map((p) => (
                <li key={p.key} className="border-b border-line last:border-b-0">
                  <Link
                    href={p.href}
                    onClick={() => setAberto(false)}
                    className="flex items-center gap-3 px-4 py-3 transition hover:bg-black/[0.03]"
                  >
                    <span className={`icon-tint shrink-0 ${ICONES[p.key].tone}`}>
                      {ICONES[p.key].icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{p.titulo}</span>
                      <span className="hint block">{p.detalhe}</span>
                    </span>
                    <span aria-hidden className="text-muted">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
