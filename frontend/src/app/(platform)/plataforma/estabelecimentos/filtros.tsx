'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { PLATFORM_PLANS, PLATFORM_TENANT_STATUSES } from '@petshop/shared-types'

/**
 * O recorte da lista de estabelecimentos.
 *
 * O estado vive na **URL**, como nos relatórios do Admin e pelo mesmo motivo: o filtro é a
 * pergunta que alguém está fazendo, e uma pergunta que não cabe num link não pode ser
 * mandada para quem vai responder. "Os que falharam no provisionamento" é exatamente o
 * tipo de link que se cola num chamado.
 *
 * Cartão branco: há campos aqui, mas isto é barra de recorte de uma tela de leitura, e o
 * `tone="soft"` marcaria como ficha o que é filtro (`docs/design-formularios.md`, regra 1).
 *
 * A busca é por nome ou slug, e **nunca** por dado de tutor — este painel não os alcança.
 */

const STATUS_ROTULO: Record<string, string> = {
  PROVISIONING: 'Provisionando',
  PROVISIONING_FAILED: 'Provisionamento falhou',
  TRIAL: 'Em teste',
  ACTIVE: 'Ativo',
  PAST_DUE: 'Em atraso',
  SUSPENDED: 'Suspenso',
  TERMINATED: 'Encerrado',
}

const PLANO_ROTULO: Record<string, string> = {
  STARTER: 'Starter',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
}

export function Filtros({
  status,
  plan,
  q,
}: {
  status: string
  plan: string
  q: string
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
        // A página volta ao começo: filtrar e continuar na página 4 devolve uma lista
        // vazia que se lê como "não há nenhum".
        startTransition(() => router.push(`/plataforma/estabelecimentos?${search.toString()}`))
      }}
    >
      <label className="block min-w-[14rem] flex-1">
        <span className="hint">Buscar</span>
        <input
          type="search"
          name="q"
          className="field mt-1"
          defaultValue={q}
          placeholder="nome ou slug"
        />
      </label>

      <label className="block">
        <span className="hint">Estado</span>
        <select name="status" className="field mt-1" defaultValue={status}>
          <option value="">Todos</option>
          {PLATFORM_TENANT_STATUSES.map((valor) => (
            <option key={valor} value={valor}>
              {STATUS_ROTULO[valor] ?? valor}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="hint">Plano</span>
        <select name="plan" className="field mt-1" defaultValue={plan}>
          <option value="">Todos</option>
          {PLATFORM_PLANS.map((valor) => (
            <option key={valor} value={valor}>
              {PLANO_ROTULO[valor] ?? valor}
            </option>
          ))}
        </select>
      </label>

      <button type="submit" className="btn btn-ghost ml-auto" disabled={pendente}>
        {pendente ? 'Carregando…' : 'Aplicar'}
      </button>
    </form>
  )
}
