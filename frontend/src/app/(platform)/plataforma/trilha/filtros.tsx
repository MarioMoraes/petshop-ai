'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { JANELAS, type Janela } from './janelas'
import { Button } from '@/components/ui'

/**
 * O recorte da trilha.
 *
 * Três alavancas, e nenhuma delas é o nome de uma pessoa: pergunta-se **o que** foi feito
 * (`action`), **onde** (o estabelecimento) e **quando**. A busca por ator existe na rota e
 * não entra aqui porque ela pede um identificador que ninguém decora — quem chega numa
 * pessoa chega por uma linha, e não por um campo de busca.
 *
 * `support.read` é o filtro que dá nome ao módulo: é como se pergunta o que o suporte leu
 * na base de um cliente. Fica no atalho porque é a pergunta que a trilha existe para
 * responder.
 */

const ACOES = [
  'support.read',
  'support_access.approved',
  'platform.admin_granted',
  'platform.audit_read',
  'tenant.updated',
  // MOD-IDENT-03: sincronização de usuário pelo webhook do Clerk. São linhas sem tenant,
  // e por isso só este painel as vê.
  'user.synced',
  'user.disabled',
]

export function Filtros({
  action,
  tenantId,
  janela,
  tenants,
}: {
  action: string
  tenantId: string
  janela: Janela
  /** Os estabelecimentos que o painel conhece, para o seletor não pedir um UUID. */
  tenants: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [pendente, startTransition] = useTransition()

  return (
    <form
      className="card flex flex-wrap items-end gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const search = new URLSearchParams()
        for (const [chave, valor] of data.entries()) {
          if (typeof valor === 'string' && valor !== '') search.set(chave, valor)
        }
        // O cursor não sobrevive à troca de filtro: ele aponta para uma posição da lista
        // anterior, e reaproveitá-lo abriria a nova consulta no meio de lugar nenhum.
        startTransition(() => router.push(`/plataforma/trilha?${search.toString()}`))
      }}
    >
      <label className="block min-w-[14rem] flex-1">
        <span className="hint">Ação</span>
        <input
          type="text"
          name="action"
          list="acoes-conhecidas"
          className="field mt-1"
          defaultValue={action}
          placeholder="support.read"
        />
        <datalist id="acoes-conhecidas">
          {ACOES.map((nome) => (
            <option key={nome} value={nome} />
          ))}
        </datalist>
      </label>

      <label className="block min-w-[12rem]">
        <span className="hint">Estabelecimento</span>
        <select name="tenantId" className="field mt-1" defaultValue={tenantId}>
          <option value="">Todos</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="hint">Janela</span>
        <select name="janela" className="field mt-1" defaultValue={janela}>
          {JANELAS.map((opcao) => (
            <option key={opcao.value} value={opcao.value}>
              {opcao.label}
            </option>
          ))}
        </select>
      </label>

      <Button
        type="submit"
        variant="ghost"
        className="ml-auto"
        busy={pendente}
        busyLabel="Consultando…"
      >
        Aplicar
      </Button>
    </form>
  )
}
