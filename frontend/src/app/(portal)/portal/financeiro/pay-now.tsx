'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui'
import { abrirPagamento } from './actions'

/**
 * O "Pagar agora" — o link de pagamento do Asaas do petshop, por PIX ou cartão.
 *
 * Um botão de cliente num cartão de servidor: é a única coisa desta tela que precisa de
 * clique com resposta. O link abre na mesma aba, porque a página do Asaas devolve o tutor
 * para cá quando termina — em outra aba, ele voltaria para uma tela velha, com o saldo de
 * antes.
 */
export function PayNow({ valor }: { valor: string }) {
  const [erro, setErro] = useState<string | null>(null)
  const [abrindo, startTransition] = useTransition()

  function pagar() {
    setErro(null)
    startTransition(async () => {
      const resultado = await abrirPagamento()
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      window.location.assign(resultado.url)
    })
  }

  return (
    <div className="mt-4">
      <Button type="button" className="w-full" busy={abrindo} onClick={pagar} busyLabel="Abrindo…">
        Pagar {valor} agora
      </Button>
      <p className="hint mt-2 text-center">PIX ou cartão. A baixa na sua conta é automática.</p>
      {erro && (
        <p className="error-text mt-2" role="alert">
          {erro}
        </p>
      )}
    </div>
  )
}
