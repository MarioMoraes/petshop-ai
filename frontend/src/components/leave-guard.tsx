'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Route } from 'next'
import { useRouter } from 'next/navigation'
import { Modal } from './modal'
import { Button } from './ui'
import { AlertTriangleIcon, type IconTone } from './icons'

/**
 * Pergunta antes de abandonar um cadastro pela metade.
 *
 * No balcão, o clique no menu no meio da ficha é o mais comum dos acidentes — o
 * telefone toca, alguém pede a agenda, e o cadastro de quatro cartões some sem aviso.
 * A guarda só acorda depois da primeira tecla dentro do formulário (o evento `input`
 * do DOM, que todo campo dispara), e cobre as duas saídas que o navegador deixa ver:
 *
 *   · **link interno** — o clique é interceptado na captura do `document`, antes do
 *     `<Link>` do Next, e a janela pergunta; confirmado, a navegação segue pelo router;
 *   · **recarregar ou fechar a aba** — `beforeunload`, com o aviso do próprio navegador,
 *     que é o único que ele permite nesse caso.
 *
 * O voltar do navegador fica de fora de propósito: interceptar `popstate` exige
 * reescrever o histórico, e um voltar que não volta é pior do que o problema.
 *
 * `release()` desliga a guarda — quem grava chama antes do `router.push` do sucesso,
 * senão a própria navegação de quem salvou perguntaria se quer sair sem salvar.
 */
export function useLeaveGuard(
  formRef: RefObject<HTMLFormElement | null>,
  tone: IconTone,
): { release: () => void; guard: ReactNode } {
  const router = useRouter()
  const dirty = useRef(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  useEffect(() => {
    const form = formRef.current
    if (!form) return

    const markDirty = () => {
      dirty.current = true
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return
      event.preventDefault()
      // Navegadores antigos só mostram o aviso com `returnValue` preenchido.
      event.returnValue = ''
    }

    const onClick = (event: MouseEvent) => {
      if (!dirty.current || event.defaultPrevented || event.button !== 0) return
      // Ctrl/⌘/Shift abrem noutra aba: o cadastro desta continua de pé.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const anchor = (event.target as Element | null)?.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return

      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      // Âncora na mesma página não sai dela.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return

      event.preventDefault()
      event.stopPropagation()
      setPendingHref(url.pathname + url.search + url.hash)
    }

    form.addEventListener('input', markDirty)
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      form.removeEventListener('input', markDirty)
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [formRef])

  const release = useCallback(() => {
    dirty.current = false
  }, [])

  const stay = () => setPendingHref(null)
  const leave = () => {
    const href = pendingHref
    dirty.current = false
    setPendingHref(null)
    if (href) router.push(href as Route)
  }

  const guard = (
    <Modal
      open={pendingHref !== null}
      onClose={stay}
      icon={<AlertTriangleIcon />}
      tone={tone}
      eyebrow="Cadastro em andamento"
      title="Sair sem salvar?"
      footer={
        <>
          <Button variant="ghost" onClick={stay}>
            Continuar editando
          </Button>
          <Button onClick={leave}>Sair sem salvar</Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        O que foi preenchido nesta tela ainda não foi gravado e será perdido.
      </p>
    </Modal>
  )

  return { release, guard }
}
