'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { MenuIcon, XIcon } from './icons'

/**
 * O menu lateral no celular: abaixo de `lg` ele vira uma gaveta que o botão de três
 * traços abre por cima do conteúdo.
 *
 * Substitui a faixa horizontal de pílulas que existia aqui: com doze itens ela rolava de
 * lado, e o item que a pessoa procurava quase sempre estava fora da tela. A gaveta mostra
 * a mesma lista da lateral — com ícone, tom e selo de plano —, então o menu é um só nos
 * dois tamanhos.
 *
 * O conteúdo chega como `children` já renderizado no servidor; aqui só mora o estado de
 * aberto. Fecha na troca de rota, no Esc e no toque fora.
 */
export function MobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        aria-label="Abrir menu"
        aria-expanded={open}
        aria-controls="menu-movel"
        onClick={() => setOpen(true)}
        className="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-full transition hover:bg-black/5 lg:hidden"
      >
        <span className="icon-tint icon-system flex">
          <MenuIcon />
        </span>
      </button>

      <div
        className={`fixed inset-0 z-40 lg:hidden ${open ? '' : 'pointer-events-none'}`}
        aria-hidden={!open}
      >
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/30 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
        />
        <aside
          id="menu-movel"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          inert={!open}
          className={`absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-surface px-4 py-5 shadow-xl transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setOpen(false)}
            className="absolute right-3 top-4 grid h-9 w-9 place-items-center rounded-full transition hover:bg-black/5"
          >
            <span className="icon-tint icon-system flex">
              <XIcon />
            </span>
          </button>
          {children}
        </aside>
      </div>
    </>
  )
}
