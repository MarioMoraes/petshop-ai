'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

/**
 * A pergunta que se faz à série.
 *
 * **O nome da métrica é campo livre, e é assim de propósito**: as métricas nascem no código
 * que as emite — são mais de sessenta hoje —, e uma lista fechada aqui garantiria que a
 * mais nova, justamente a do problema que se está investigando, fosse a que falta.
 *
 * O `datalist` traz oito atalhos, e não o inventário: são as que se abre por hábito. Ele
 * sugere sem restringir — quem digita um nome que não está ali é atendido do mesmo jeito.
 */

/** Os atalhos. Curto de propósito: uma lista de sessenta nomes não se lê num seletor. */
const ATALHOS = [
  'receivables_overdue_cents',
  'messages_dispatched',
  'message_queue_stuck',
  'job_failure_total',
  'tenant_onboarding_completed',
  'pet_search_latency',
  'taxi_window_adherence_rate',
  'support_read_total',
]

export const JANELAS = [
  { value: '24h', label: '24 horas' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: '13m', label: '13 meses' },
] as const

export type Janela = (typeof JANELAS)[number]['value']

export function Consulta({
  metric,
  janela,
  groupBy,
}: {
  metric: string
  janela: Janela
  groupBy: 'total' | 'tenant'
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
        startTransition(() => router.push(`/plataforma/metricas?${search.toString()}`))
      }}
    >
      <label className="block min-w-[16rem] flex-1">
        <span className="hint">Métrica</span>
        <input
          type="text"
          name="metric"
          list="metricas-conhecidas"
          className="field mt-1"
          defaultValue={metric}
          placeholder="messages_dispatched"
          required
        />
        <datalist id="metricas-conhecidas">
          {ATALHOS.map((nome) => (
            <option key={nome} value={nome} />
          ))}
        </datalist>
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

      <label className="block">
        <span className="hint">Recorte</span>
        <select name="groupBy" className="field mt-1" defaultValue={groupBy}>
          <option value="total">Somando todos</option>
          <option value="tenant">Por estabelecimento</option>
        </select>
      </label>

      <button type="submit" className="btn btn-ghost ml-auto" disabled={pendente}>
        {pendente ? 'Consultando…' : 'Consultar'}
      </button>
    </form>
  )
}
