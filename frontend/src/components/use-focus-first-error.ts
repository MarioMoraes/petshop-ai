'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Leva o atendente ao primeiro problema depois de um envio recusado.
 *
 * O erro de campo aparece embaixo do campo, mas quem clicou em salvar está no rodapé
 * — num formulário de quatro cartões, o campo apontado fica fora da tela e o envio
 * parece não ter feito nada. A peça rola até o primeiro `aria-invalid="true"` e põe o
 * cursor nele; sem campo marcado, rola até o primeiro alerta (duplicata, conflito).
 *
 * `signal` é o que muda a cada tentativa recusada — o objeto da falha, nunca um `{}`
 * recriado a cada render, senão a tela pularia para o erro a cada tecla.
 */
export function useFocusFirstError(
  formRef: RefObject<HTMLFormElement | null>,
  signal: unknown,
): void {
  useEffect(() => {
    if (!signal) return
    const form = formRef.current
    if (!form) return

    const target =
      form.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form.querySelector<HTMLElement>('[role="alert"]')
    if (!target) return

    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (target.matches('input, select, textarea')) target.focus({ preventScroll: true })
  }, [formRef, signal])
}
