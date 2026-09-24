'use client'

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { AlertTriangleIcon, CheckIcon } from './icons'

/**
 * O aviso de que a gravação vingou.
 *
 * Salvar fazia `router.push` ou `router.refresh` e a tela simplesmente mudava. Para quem
 * acabou de clicar isso é ambíguo: a ficha nova apareceu porque gravou, ou porque o
 * clique caiu num link? E nas telas de configuração o "salvo" morava no topo da página,
 * fora de vista para quem salvou lá embaixo. Uma pílula escura no pé da tela, por três
 * segundos, responde sem pedir nada.
 *
 * **Mora no layout raiz do Admin, e não na tela**, porque o caso mais comum é gravar e
 * navegar: o aviso é disparado no formulário e precisa sobreviver à troca de rota para
 * ser lido na ficha de destino. O layout não remonta numa navegação do App Router, e o
 * estado vai junto.
 *
 * É para o que **deu certo**. Erro continua no `<Alert>`/`<FormError>` ao lado do campo
 * que precisa ser corrigido: um erro que some sozinho em três segundos é um erro que
 * ninguém consegue ler até o fim. O tom `danger` existe para a falha que não tem campo
 * onde morar — e é raro de propósito.
 *
 * `role="status"` e `aria-live="polite"` na região, não em cada aviso: o leitor de tela
 * anuncia o que entra sem interromper o que estava lendo.
 */

type Tone = 'success' | 'danger'

interface Toast {
  id: number
  message: string
  tone: Tone
  leaving: boolean
}

type Notify = (message: string, tone?: Tone) => void

const ToastContext = createContext<Notify | null>(null)

/** Quanto o aviso fica na tela. Três segundos lêem uma frase curta com folga. */
const VISIBLE_MS = 3200
/** A saída é uma animação de CSS; o nó só sai do DOM quando ela termina. */
const LEAVE_MS = 200
/** Mais de três empilhados deixa de ser aviso e vira ruído — os mais antigos saem. */
const MAX = 3

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((list) =>
      list.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
    )
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), LEAVE_MS)
  }, [])

  const notify = useCallback<Notify>(
    (message, tone = 'success') => {
      const id = nextId.current++
      setToasts((list) => [...list, { id, message, tone, leaving: false }].slice(-MAX))
      setTimeout(() => dismiss(id), VISIBLE_MS)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className="toast"
            data-tone={toast.tone}
            data-leaving={toast.leaving || undefined}
            onClick={() => dismiss(toast.id)}
            aria-label={`${toast.message} — fechar aviso`}
          >
            <span className="toast-icon">
              {toast.tone === 'success' ? <CheckIcon /> : <AlertTriangleIcon />}
            </span>
            {toast.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/**
 * `const toast = useToast()` e depois `toast('Tutor cadastrado.')`.
 *
 * Fora do provider devolve uma função que não faz nada, em vez de lançar: um formulário
 * reaproveitado noutra raiz (o onboarding, um teste) continua gravando sem aviso, que
 * é o comportamento de antes — e não quebrando por causa de um enfeite.
 */
export function useToast(): Notify {
  return useContext(ToastContext) ?? noop
}

function noop() {}
