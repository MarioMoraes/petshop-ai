'use client'

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { IconTone } from './icons'

/**
 * Diálogo modal do sistema (`globals.css` §Diálogo).
 *
 * O produto não tinha um. O que precisava de foco exclusivo — concluir um atendimento,
 * pedir o leva-e-traz — abria um painel dentro do cartão que o originou, espremido na
 * largura de uma coluna e empurrando o resto da tela para baixo. Este componente é a
 * peça que faltava no kit, não um detalhe da agenda: quem precisar de foco exclusivo
 * daqui em diante usa esta e não desenha a sua.
 *
 * O que ele garante, e que é o motivo de não ser só uma `div` com `position: fixed`:
 *
 * - **Portal para o `body`.** O gatilho mora dentro de um bloco com `overflow: auto`
 *   (a linha do tempo) e `transform` (o `hover` do cartão). Qualquer um dos dois vira
 *   bloco de contenção e recortaria o diálogo dentro da coluna que o abriu.
 * - **Foco preso.** `Tab` circula dentro do painel, e `Escape` devolve o foco ao
 *   elemento que abriu — sem isso, fechar o diálogo joga o teclado no início da página
 *   e quem navega sem mouse recomeça a tela.
 * - **`busy` tranca as saídas.** Enquanto a ação está no ar, nem `Escape` nem o clique
 *   no véu fecham. Um check-out interrompido no meio deixa a observação salva e o
 *   atendimento aberto (ver `agenda/actions.ts`), e ninguém sabe se clicou fora antes
 *   ou depois de dar certo.
 */

const FOCALIZAVEIS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface ModalProps {
  open: boolean
  onClose: () => void
  /** Chip do cabeçalho: o glifo do domínio. */
  icon: ReactNode
  /** Tom do chip — o do domínio no menu lateral (`docs/design-formularios.md`, §3). */
  tone: IconTone
  /** Olho-de-boi: o que a janela **é**. */
  eyebrow?: string
  /** Título: de quem ou de quê ela trata. */
  title: string
  /** A linha de contexto que impede o preenchimento na ficha errada. */
  subtitle?: ReactNode
  /** Barra de ações do rodapé. Sem ela, o rodapé não é desenhado. */
  footer?: ReactNode
  /** Volta para a vista anterior, à esquerda do título. */
  onBack?: (() => void) | undefined
  /** Ação em andamento: trava o fechamento acidental. */
  busy?: boolean
  children: ReactNode
}

export function Modal({
  open,
  onClose,
  icon,
  tone,
  eyebrow,
  title,
  subtitle,
  footer,
  onBack,
  busy = false,
  children,
}: ModalProps) {
  const painel = useRef<HTMLDivElement>(null)
  /** Quem tinha o foco quando a janela abriu. Devolvido no fechamento. */
  const origem = useRef<HTMLElement | null>(null)
  const tituloId = useId()

  const fechar = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  useEffect(() => {
    if (!open) return

    origem.current = document.activeElement as HTMLElement | null

    // Foca o painel, e não o primeiro botão: abrir uma janela com o "Cancelar" já
    // iluminado sugere que cancelar é o que se espera. Do painel, um `Tab` leva ao
    // primeiro campo, que é para onde a pessoa ia de qualquer jeito.
    painel.current?.focus()

    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    function aoTeclar(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        fechar()
        return
      }

      if (event.key !== 'Tab' || !painel.current) return

      const alvos = [...painel.current.querySelectorAll<HTMLElement>(FOCALIZAVEIS)].filter(
        (elemento) => elemento.offsetParent !== null,
      )
      if (alvos.length === 0) {
        event.preventDefault()
        painel.current.focus()
        return
      }

      const primeiro = alvos[0]!
      const ultimo = alvos[alvos.length - 1]!
      const atual = document.activeElement

      // Do painel (que não é focalizável por `Tab`) o ciclo começa no primeiro.
      if (event.shiftKey && (atual === primeiro || atual === painel.current)) {
        event.preventDefault()
        ultimo.focus()
      } else if (!event.shiftKey && atual === ultimo) {
        event.preventDefault()
        primeiro.focus()
      }
    }

    document.addEventListener('keydown', aoTeclar, true)

    return () => {
      document.removeEventListener('keydown', aoTeclar, true)
      document.body.style.overflow = overflow
      // O foco volta para o gatilho — o bloco do atendimento, no caso da agenda.
      origem.current?.focus?.()
    }
  }, [open, fechar])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="dialog-veil" onPointerDown={fechar} aria-hidden="true" />

      <div
        ref={painel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        tabIndex={-1}
        className="dialog-panel focus:outline-none"
      >
        <div className="dialog-head">
          {onBack && (
            <button
              type="button"
              className="dialog-close"
              onClick={onBack}
              disabled={busy}
              aria-label="Voltar"
            >
              <BackGlyph />
            </button>
          )}

          <span className={`icon-chip icon-chip-sm ${tone}`}>{icon}</span>

          <div className="min-w-0 flex-1">
            {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
            <h2 id={tituloId} className="section-title truncate">
              {title}
            </h2>
            {subtitle && <div className="hint mt-1">{subtitle}</div>}
          </div>

          <button
            type="button"
            className="dialog-close"
            onClick={fechar}
            disabled={busy}
            aria-label="Fechar"
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="dialog-body">{children}</div>

        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  )
}

function CloseGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function BackGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}
