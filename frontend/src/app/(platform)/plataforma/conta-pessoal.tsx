'use client'

import { useState } from 'react'
import { useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui'

/**
 * Sair do estabelecimento e voltar à conta pessoal.
 *
 * **É a única ação de cliente do console**, e existe por causa de uma regra do backend:
 * token com Organization nunca resolve sessão de plataforma (AC-03 de MOD-ADMIN-01). Quem
 * é da equipe e também administra um petshop não soma os dois crachás — precisa trocar de
 * contexto, e o `org_id` mora no token, que só o SDK do Clerk reescreve.
 *
 * `setActive` vem do `useOrganizationList`, e não do `useClerk`, pela mesma razão do
 * `TenantSwitcher`: é o caminho que já se provou nesta base, e o `isLoaded` dele diz
 * quando o SDK terminou de subir. Sem essa espera o botão clica em falso — que foi
 * exatamente o sintoma relatado na primeira versão desta tela.
 *
 * `organization: null` é a conta pessoal. O `refresh` depois não é enfeite: as telas são
 * Server Components e já foram renderizadas com o token antigo; sem ele, a pessoa troca de
 * contexto e continua vendo a porta fechada.
 *
 * **O erro aparece.** Uma instalação do Clerk com conta pessoal desligada recusa a troca,
 * e sem esta linha a recusa seria mais um clique sem efeito.
 */
export function ContaPessoal() {
  const router = useRouter()
  const { isLoaded, setActive } = useOrganizationList()
  const [saindo, setSaindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  async function sair() {
    if (!setActive) return
    setErro(null)
    setSaindo(true)

    try {
      await setActive({ organization: null })
      router.refresh()
    } catch (falha) {
      setErro(
        falha instanceof Error
          ? falha.message
          : 'O Clerk recusou a troca de contexto. Saia e entre de novo.',
      )
    } finally {
      setSaindo(false)
    }
  }

  return (
    <span className="flex flex-col items-center gap-2">
      <Button
        type="button"
        disabled={!isLoaded}
        busy={saindo}
        busyLabel="Trocando…"
        onClick={() => void sair()}
      >
        Usar minha conta pessoal
      </Button>
      {erro && (
        <span className="error-text" role="alert">
          {erro}
        </span>
      )}
    </span>
  )
}
