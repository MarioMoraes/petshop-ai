'use client'

import { useState, useTransition } from 'react'
import {
  SCHEDULE_GRID_MIN,
  SERVICE_CATEGORY_LABELS,
  type ServiceCategory,
  type ServiceResponse,
  type Size,
} from '@petshop/shared-types'
import { Badge, Card, EmptyState, Field } from '@/components/ui'
import {
  createServiceAction,
  deleteServiceAction,
  replacePricingAction,
  updateServiceAction,
  type ActionFailure,
} from '../actions'

/**
 * Gestão do catálogo de serviços.
 *
 * O preço é editado **na linha**, sem abrir modal: a operação mais comum aqui é
 * revisar a tabela que veio semeada no provisionamento, e revisar quatro números por
 * serviço através de um diálogo por vez seria hostil.
 *
 * Duração e preço andam juntos porque a decisão do §11 Q1 os pôs na mesma linha:
 * duração é tabela por porte, não multiplicador. Separar os dois campos em telas
 * diferentes esconderia justamente a relação que o petshop precisa enxergar.
 */

interface Props {
  services: ServiceResponse[]
  sizes: Size[]
}

const CATEGORIES = Object.entries(SERVICE_CATEGORY_LABELS) as [ServiceCategory, string][]

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
}

function parseCents(value: string): number {
  const digits = value.replace(/\D/g, '')
  return digits ? Number(digits) : 0
}

export function ServicesManager({ services, sizes }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [pending, startTransition] = useTransition()

  function run(action: () => Promise<{ ok: true } | ActionFailure>, onDone?: () => void) {
    setFailure(null)
    startTransition(async () => {
      const result = await action()
      if (result.ok) onDone?.()
      else setFailure(result)
    })
  }

  if (services.length === 0 && !creating) {
    return (
      <EmptyState
        title="Nenhum serviço cadastrado"
        description="Os serviços definem o que o tutor pode agendar e quanto custa cada porte."
        action={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Cadastrar serviço
          </button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      {failure && (
        <div className="card border-danger/40 px-5 py-4" role="alert">
          <p className="font-medium">{failure.message}</p>
          {failure.futureAppointments !== undefined && (
            <p className="hint mt-1">
              {failure.futureAppointments} agendamento(s) usam este serviço. Desative-o para
              tirá-lo do seletor sem afetar o que já está marcado.
            </p>
          )}
        </div>
      )}

      {services.map((service) => (
        <ServiceRow
          key={service.id}
          service={service}
          sizes={sizes}
          expanded={editing === service.id}
          pending={pending}
          onToggle={() => setEditing(editing === service.id ? null : service.id)}
          onSavePricing={(pricing) =>
            run(() => replacePricingAction(service.id, { pricing }), () => setEditing(null))
          }
          onToggleActive={() =>
            run(() => updateServiceAction(service.id, { active: !service.active }))
          }
          onDelete={() => run(() => deleteServiceAction(service.id))}
        />
      ))}

      {creating ? (
        <NewServiceForm
          sizes={sizes}
          pending={pending}
          onCancel={() => setCreating(false)}
          onSubmit={(input) => run(() => createServiceAction(input), () => setCreating(false))}
        />
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => setCreating(true)}>
          Adicionar serviço
        </button>
      )}
    </div>
  )
}

// ─── Linha do serviço ────────────────────────────────────────────────────────

interface RowProps {
  service: ServiceResponse
  sizes: Size[]
  expanded: boolean
  pending: boolean
  onToggle: () => void
  onSavePricing: (pricing: { sizeId: string; priceCents: number; durationMin: number }[]) => void
  onToggleActive: () => void
  onDelete: () => void
}

function ServiceRow({
  service,
  sizes,
  expanded,
  pending,
  onToggle,
  onSavePricing,
  onToggleActive,
  onDelete,
}: RowProps) {
  // O estado nasce da tabela existente, completada com os portes que faltam. É assim
  // que o buraco de preço fica visível **e** preenchível no mesmo lugar.
  const [draft, setDraft] = useState(() =>
    sizes.map((size) => {
      const existing = service.pricing.find((item) => item.sizeId === size.id)
      return {
        sizeId: size.id,
        label: size.label,
        priceCents: existing?.priceCents ?? 0,
        durationMin: existing?.durationMin ?? service.baseDurationMin,
        missing: !existing,
      }
    }),
  )

  const missing = draft.filter((item) => item.missing).length
  const invalid = draft.filter((item) => item.durationMin % SCHEDULE_GRID_MIN !== 0)

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{service.name}</h2>
            <Badge tone="neutral">{SERVICE_CATEGORY_LABELS[service.category]}</Badge>
            {service.requiresVet && <Badge tone="accent">Exige veterinário</Badge>}
            {!service.active && <Badge tone="neutral">Desativado</Badge>}
            {service.active && missing > 0 && (
              <Badge tone="danger">
                {missing === 1 ? '1 porte sem preço' : `${missing} portes sem preço`}
              </Badge>
            )}
          </div>
          {service.description && <p className="hint mt-1">{service.description}</p>}
        </div>

        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn btn-ghost" onClick={onToggle}>
            {expanded ? 'Fechar' : 'Preços'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={onToggleActive}
          >
            {service.active ? 'Desativar' : 'Reativar'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-5 border-t border-line pt-5">
          <div className="space-y-2">
            {draft.map((item, index) => (
              <div
                key={item.sizeId}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-line px-4 py-3"
              >
                <span className="w-24 text-sm font-medium">{item.label}</span>

                <div className="flex items-center gap-2">
                  <span className="hint">R$</span>
                  <input
                    className="field w-28"
                    inputMode="numeric"
                    value={formatCents(item.priceCents)}
                    aria-label={`Preço para ${item.label}`}
                    onChange={(event) =>
                      setDraft((current) =>
                        current.map((row, i) =>
                          i === index
                            ? { ...row, priceCents: parseCents(event.target.value), missing: false }
                            : row,
                        ),
                      )
                    }
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    className="field w-24"
                    step={SCHEDULE_GRID_MIN}
                    min={SCHEDULE_GRID_MIN}
                    max={600}
                    value={item.durationMin}
                    aria-label={`Duração para ${item.label}`}
                    onChange={(event) =>
                      setDraft((current) =>
                        current.map((row, i) =>
                          i === index
                            ? { ...row, durationMin: Number(event.target.value), missing: false }
                            : row,
                        ),
                      )
                    }
                  />
                  <span className="hint">min</span>
                </div>

                {item.missing && <span className="hint text-danger">sem preço</span>}
              </div>
            ))}
          </div>

          {invalid.length > 0 && (
            <p className="error-text mt-3" role="alert">
              A duração precisa ser múltipla de {SCHEDULE_GRID_MIN} minutos — é a grade que a
              agenda usa para oferecer horários.
            </p>
          )}

          <div className="mt-5 flex flex-wrap justify-between gap-2">
            <button
              type="button"
              className="btn btn-ghost text-danger"
              disabled={pending}
              onClick={onDelete}
            >
              Excluir serviço
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || invalid.length > 0}
              onClick={() =>
                onSavePricing(
                  draft.map((item) => ({
                    sizeId: item.sizeId,
                    priceCents: item.priceCents,
                    durationMin: item.durationMin,
                  })),
                )
              }
            >
              {pending ? 'Salvando…' : 'Salvar preços'}
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── Novo serviço ────────────────────────────────────────────────────────────

function NewServiceForm({
  sizes,
  pending,
  onCancel,
  onSubmit,
}: {
  sizes: Size[]
  pending: boolean
  onCancel: () => void
  onSubmit: (input: unknown) => void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState<ServiceCategory>('BATH')
  const [duration, setDuration] = useState(60)
  const [requiresVet, setRequiresVet] = useState(false)

  return (
    <Card>
      <h2 className="text-lg font-semibold">Novo serviço</h2>
      <p className="hint mt-1">
        Ele nasce com a duração base em todos os portes e sem preço. Preencha os valores logo
        depois — porte sem preço não pode ser agendado.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Nome" htmlFor="novo-servico-nome">
          <input
            id="novo-servico-nome"
            className="field"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Categoria" htmlFor="novo-servico-categoria">
          <select
            id="novo-servico-categoria"
            className="field"
            value={category}
            onChange={(event) => setCategory(event.target.value as ServiceCategory)}
          >
            {CATEGORIES.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Duração base" htmlFor="novo-servico-duracao" hint="Ajustável por porte.">
          <div className="flex items-center gap-2">
            <input
              id="novo-servico-duracao"
              type="number"
              className="field w-28"
              step={SCHEDULE_GRID_MIN}
              min={SCHEDULE_GRID_MIN}
              max={600}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
            />
            <span className="hint">min</span>
          </div>
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            className="check"
            type="checkbox"
            checked={requiresVet}
            onChange={(event) => setRequiresVet(event.target.checked)}
          />
          Só veterinário pode executar
        </label>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || name.trim().length < 2 || duration % SCHEDULE_GRID_MIN !== 0}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              category,
              baseDurationMin: duration,
              requiresVet,
              pricing: sizes.map((size) => ({
                sizeId: size.id,
                priceCents: 0,
                durationMin: duration,
              })),
              professionalIds: [],
            })
          }
        >
          {pending ? 'Criando…' : 'Criar serviço'}
        </button>
      </div>
    </Card>
  )
}
