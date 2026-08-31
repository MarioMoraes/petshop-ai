'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import type {
  CreditCheckResponse,
  ProfessionalResponse,
  ServiceResponse,
} from '@petshop/shared-types'
import { Badge, Card, Field } from '@/components/ui'
import {
  availabilityAction,
  createAppointmentAction,
  creditCheckAction,
  searchPetsAction,
  type ActionFailure,
} from '../actions'

/**
 * O fluxo de marcar horário, em quatro passos numa tela só.
 *
 * Uma tela e não quatro páginas: a recepção faz isto com o tutor na frente e o pet na
 * coleira, e cada navegação é uma chance de perder o que já foi preenchido.
 *
 * A ordem é imposta pelo domínio, não por estética. A disponibilidade **depende do
 * pet e do serviço** — porte e pelagem mudam o tamanho do buraco necessário —, então
 * não há como mostrar horários antes de saber os dois. É por isso que os passos 1 e 2
 * vêm antes do 3, e não porque ficaria bonito assim.
 */

interface Props {
  services: ServiceResponse[]
  professionals: ProfessionalResponse[]
  initialDate: string
  initialPetId: string | null
}

interface PetOption {
  id: string
  name: string
  tutorId: string | null
  tutorName: string
  sizeLabel: string
}

interface Slot {
  professionalId: string
  professionalName: string
  startsAt: string
  endsAt: string
  durationMin: number
  priceCents: number
}

function money(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
}

/**
 * A hora é sempre a **do petshop**, nunca a do navegador.
 *
 * Sem `timeZone` explícito o `toLocaleTimeString` usa o fuso de quem está olhando: a
 * recepcionista acessando de outro estado, ou o tutor viajando, leriam um horário que
 * não é o do agendamento. O fuso vem do tenant, junto com os horários.
 */
function hour(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  })
}

function dayLabel(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
  })
}

/** O dia civil de um instante, no fuso do petshop — a chave do seletor de data. */
function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

export function BookingWizard({ services, professionals, initialDate, initialPetId }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [pet, setPet] = useState<PetOption | null>(null)
  const [serviceIds, setServiceIds] = useState<string[]>([])
  const [professionalId, setProfessionalId] = useState<string>('')
  const [date, setDate] = useState(initialDate)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [nextAvailable, setNextAvailable] = useState<string | null>(null)
  // Até a primeira resposta chegar, o fuso do próprio navegador é o palpite menos
  // errado: quase sempre é o mesmo do petshop, e nada é exibido antes disso.
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  const [chosen, setChosen] = useState<Slot | null>(null)
  const [notes, setNotes] = useState('')
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const slotsRequestId = useRef(0)

  const activeServices = services.filter((service) => service.active)
  const chosenServices = activeServices.filter((service) => serviceIds.includes(service.id))

  // Só os profissionais habilitados em **todos** os serviços escolhidos aparecem:
  // oferecer quem não executa um deles produziria um 409 depois de escolher o horário.
  const eligible = professionals.filter(
    (person) =>
      person.active && serviceIds.every((serviceId) => person.serviceIds.includes(serviceId)),
  )

  const ready = pet !== null && serviceIds.length > 0

  function loadSlots() {
    if (!ready) return
    setFailure(null)
    setChosen(null)

    // Cada chamada leva sua própria marca. Trocar profissional, dia ou serviço
    // rápido demais deixa duas buscas em voo ao mesmo tempo, e sem isso a que
    // chegasse por último venceria — mesmo sendo a resposta da busca **anterior**,
    // vinda para um profissional ou dia que não é mais o selecionado. Descartar
    // toda resposta que não seja a da última chamada corrige o horário fantasma.
    const requestId = ++slotsRequestId.current

    startTransition(async () => {
      // A disponibilidade é consultada por serviço; com mais de um, o primeiro define
      // a grade e a confirmação valida o conjunto. É a aproximação honesta: combinar
      // n serviços exigiria o cálculo completo do lado do servidor, que a fatia de
      // encaixe múltiplo ainda não tem.
      const result = await availabilityAction({
        serviceId: serviceIds[0]!,
        petId: pet!.id,
        ...(professionalId ? { professionalId } : {}),
        from: `${date}T00:00:00.000Z`,
        to: `${date}T23:59:59.999Z`,
      })

      if (requestId !== slotsRequestId.current) return

      if (!result.ok) {
        setFailure(result)
        setSlots([])
        return
      }
      setSlots(result.data.slots)
      setNextAvailable(result.data.nextAvailable)
      setTimezone(result.data.timezone)
    })
  }

  // Recarrega os horários quando muda algo que os afeta.
  useEffect(() => {
    if (ready) loadSlots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet?.id, serviceIds.join(','), professionalId, date])

  function confirm(extra: { acknowledgedAlerts?: boolean; override?: { reason: string } } = {}) {
    if (!chosen || !pet) return
    setFailure(null)

    startTransition(async () => {
      const result = await createAppointmentAction({
        petId: pet.id,
        professionalId: chosen.professionalId,
        startsAt: chosen.startsAt,
        items: serviceIds.map((serviceId) => ({ serviceId })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        acknowledgedAlerts: extra.acknowledgedAlerts ?? false,
        ...(extra.override ? { override: extra.override } : {}),
        source: 'STAFF',
      })

      if (result.ok) {
        router.push(`/agenda/dia?date=${date}`)
        return
      }
      setFailure(result)
    })
  }

  const total = chosenServices.reduce((sum, service) => {
    const price = service.pricing[0]?.priceCents ?? 0
    return sum + price
  }, 0)

  return (
    <div className="space-y-4">
      {/* ─── 1. Pet ────────────────────────────────────────────────────── */}
      <Card>
        <StepTitle n={1} title="Qual pet" done={pet !== null} />
        {pet ? (
          <>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">
                  {pet.name} <span className="hint">· {pet.sizeLabel}</span>
                </p>
                <p className="hint">{pet.tutorName}</p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setPet(null)}>
                Trocar
              </button>
            </div>
            {pet.tutorId && <DebtNotice tutorId={pet.tutorId} amountCents={total} />}
          </>
        ) : (
          <PetPicker initialPetId={initialPetId} onPick={setPet} />
        )}
      </Card>

      {/* ─── 2. Serviços ───────────────────────────────────────────────── */}
      {pet && (
        <Card>
          <StepTitle n={2} title="Quais serviços" done={serviceIds.length > 0} />
          <div className="mt-3 flex flex-wrap gap-2">
            {activeServices.map((service) => {
              const on = serviceIds.includes(service.id)
              return (
                <button
                  key={service.id}
                  type="button"
                  aria-pressed={on}
                  className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-subtle hover:text-fg'
                  }`}
                  onClick={() =>
                    setServiceIds((current) =>
                      on ? current.filter((id) => id !== service.id) : [...current, service.id],
                    )
                  }
                >
                  {service.name}
                </button>
              )
            })}
          </div>
          {activeServices.length === 0 && (
            <p className="hint mt-3">
              Nenhum serviço ativo. Cadastre um em Serviços antes de agendar.
            </p>
          )}
        </Card>
      )}

      {/* ─── 3. Horário ────────────────────────────────────────────────── */}
      {ready && (
        <Card>
          <StepTitle n={3} title="Quando" done={chosen !== null} />

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Dia" htmlFor="agenda-data">
              <input
                id="agenda-data"
                type="date"
                className="field w-44"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </Field>

            <Field label="Profissional" htmlFor="agenda-prof">
              <select
                id="agenda-prof"
                className="field w-52"
                value={professionalId}
                onChange={(event) => setProfessionalId(event.target.value)}
              >
                <option value="">Qualquer um disponível</option>
                {eligible.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {eligible.length === 0 && (
            <p className="error-text mt-3" role="alert">
              Ninguém está habilitado em todos os serviços escolhidos. Ajuste as habilitações
              em Profissionais.
            </p>
          )}

          <div className="mt-4">
            {pending && slots === null ? (
              <p className="hint">Procurando horários…</p>
            ) : slots && slots.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {slots.map((slot) => {
                  const on = chosen?.startsAt === slot.startsAt && chosen.professionalId === slot.professionalId
                  return (
                    <button
                      key={`${slot.professionalId}-${slot.startsAt}`}
                      type="button"
                      aria-pressed={on}
                      className={`rounded-2xl border px-3 py-2 text-sm transition-colors ${
                        on ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/50'
                      }`}
                      onClick={() => setChosen(slot)}
                    >
                      <span className="font-medium">{hour(slot.startsAt, timezone)}</span>
                      {!professionalId && (
                        <span className="hint block text-xs">{slot.professionalName}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="hint">
                <p>Nenhum horário livre neste dia.</p>
                {nextAvailable && (
                  <button
                    type="button"
                    className="btn btn-ghost mt-2"
                    onClick={() => setDate(dayKey(nextAvailable, timezone))}
                  >
                    Ir para {dayLabel(nextAvailable, timezone)}, às{' '}
                    {hour(nextAvailable, timezone)}
                  </button>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ─── 4. Confirmar ──────────────────────────────────────────────── */}
      {chosen && (
        <Card>
          <StepTitle n={4} title="Confirmar" done={false} />

          <dl className="mt-3 space-y-1 text-sm">
            <Row label="Pet" value={`${pet!.name} · ${pet!.tutorName}`} />
            <Row label="Serviços" value={chosenServices.map((s) => s.name).join(', ')} />
            <Row
              label="Horário"
              value={`${dayLabel(chosen.startsAt, timezone)}, ${hour(chosen.startsAt, timezone)} às ${hour(chosen.endsAt, timezone)}`}
            />
            <Row label="Profissional" value={chosen.professionalName} />
            <Row label="Duração" value={`${chosen.durationMin} min`} />
            {total > 0 && <Row label="Valor" value={money(total)} />}
          </dl>

          <div className="mt-4">
            <Field label="Observação" htmlFor="agenda-notas" hint="Opcional. Visível só à equipe.">
              <input
                id="agenda-notas"
                className="field"
                maxLength={1000}
                placeholder="Tocar o interfone 2"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>

          {failure && <GateBanner failure={failure} reason={overrideReason} onReason={setOverrideReason} onConfirm={confirm} pending={pending} timezone={timezone} />}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => confirm()}
            >
              {pending ? 'Marcando…' : 'Marcar horário'}
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Gates ───────────────────────────────────────────────────────────────────

/**
 * O que o servidor recusou, e o que fazer a respeito.
 *
 * Alerta clínico e inadimplência não são erros: são decisões que o sistema devolve a
 * quem está no balcão. A tela mostra o motivo e oferece o caminho — confirmar ciência
 * do risco, ou justificar a liberação de crédito. Esconder isso atrás de um "erro ao
 * salvar" faria a recepção tentar de novo até desistir.
 */
/**
 * O débito do tutor, no passo 1 (MOD-LEDGER-09).
 *
 * Aparece assim que o pet é escolhido — antes de o atendente montar serviços,
 * profissional e horário. Descobrir o bloqueio só na confirmação é fazer refazer tudo
 * com o cliente na frente.
 *
 * Some quando a conta está em dia: um aviso que aparece sempre deixa de ser aviso.
 */
function DebtNotice({ tutorId, amountCents }: { tutorId: string; amountCents: number }) {
  const [check, setCheck] = useState<CreditCheckResponse | null>(null)

  useEffect(() => {
    let active = true
    void creditCheckAction(tutorId, amountCents).then((result) => {
      if (active) setCheck(result)
    })
    return () => {
      active = false
    }
  }, [tutorId, amountCents])

  if (!check?.warning) return null

  return (
    <p
      className={`hint mt-3 ${check.allowed ? '' : 'text-danger'}`}
      role={check.allowed ? undefined : 'alert'}
    >
      {check.message}
      {!check.allowed && ' — será preciso a liberação de um administrador.'}
    </p>
  )
}

function GateBanner({
  failure,
  reason,
  onReason,
  onConfirm,
  pending,
  timezone,
}: {
  failure: ActionFailure
  reason: string
  onReason: (value: string) => void
  onConfirm: (extra?: { acknowledgedAlerts?: boolean; override?: { reason: string } }) => void
  pending: boolean
  timezone: string
}) {
  if (failure.alerts && failure.alerts.length > 0) {
    return (
      <div className="card mt-4 border-danger/40 px-5 py-4" role="alert">
        <p className="font-medium">Este pet tem alerta clínico crítico</p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {failure.alerts.map((alert) => (
            <li key={alert.id}>
              <Badge tone="danger">{alert.label}</Badge>
            </li>
          ))}
        </ul>
        <p className="hint mt-2">
          O agendamento pode seguir, e fica registrado quem assumiu o risco.
        </p>
        <button
          type="button"
          className="btn btn-primary mt-3"
          disabled={pending}
          onClick={() => onConfirm({ acknowledgedAlerts: true })}
        >
          A equipe está ciente — marcar mesmo assim
        </button>
      </div>
    )
  }

  if (failure.requiresOverride) {
    return (
      <div className="card mt-4 border-danger/40 px-5 py-4" role="alert">
        <p className="font-medium">{failure.message}</p>
        <p className="hint mt-1">
          Um administrador pode liberar com justificativa, que fica registrada.
        </p>
        <input
          className="field mt-3"
          placeholder="Motivo da liberação (mínimo 10 caracteres)"
          maxLength={300}
          value={reason}
          onChange={(event) => onReason(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary mt-3"
          disabled={pending || reason.trim().length < 10}
          onClick={() => onConfirm({ override: { reason: reason.trim() } })}
        >
          Liberar e marcar
        </button>
      </div>
    )
  }

  return (
    <div className="card mt-4 border-danger/40 px-5 py-4" role="alert">
      <p className="font-medium">{failure.message}</p>
      {failure.suggestions && failure.suggestions.length > 0 && (
        <p className="hint mt-1">
          Horários próximos:{' '}
          {failure.suggestions.map((s) => hour(s.startsAt, timezone)).join(', ')}
        </p>
      )}
    </div>
  )
}

// ─── Peças ───────────────────────────────────────────────────────────────────

function StepTitle({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
          done ? 'bg-accent text-white' : 'border border-line text-subtle'
        }`}
        aria-hidden
      >
        {done ? '✓' : n}
      </span>
      <h2 className="font-semibold">{title}</h2>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="hint w-28 shrink-0">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/**
 * Busca de pet com atraso na digitação.
 *
 * Uma requisição por tecla inundaria o gateway sem melhorar nada para quem está com o
 * cliente na frente — o mesmo raciocínio da busca de `/pets`.
 */
function PetPicker({
  initialPetId,
  onPick,
}: {
  initialPetId: string | null
  onPick: (pet: PetOption) => void
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PetOption[]>([])
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setOptions([])
      return
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const result = await searchPetsAction(trimmed)
        if (result.ok) setOptions(result.data)
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Chegando de `/pets/[id]` com o pet já escolhido, carrega direto.
  useEffect(() => {
    if (!initialPetId) return
    startTransition(async () => {
      const result = await searchPetsAction('')
      if (result.ok) {
        const found = result.data.find((pet) => pet.id === initialPetId)
        if (found) onPick(found)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPetId])

  return (
    <div className="mt-3">
      <input
        className="field"
        placeholder="Buscar pet por nome…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Buscar pet"
      />

      {pending && <p className="hint mt-2">Buscando…</p>}

      {options.length > 0 && (
        <ul className="mt-2 space-y-1">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                className="w-full rounded-2xl border border-line px-4 py-2.5 text-left transition-colors hover:border-accent/50"
                onClick={() => onPick(option)}
              >
                <span className="font-medium">{option.name}</span>
                <span className="hint"> · {option.sizeLabel}</span>
                <span className="hint block text-xs">{option.tutorName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.trim().length >= 2 && !pending && options.length === 0 && (
        <p className="hint mt-2">Nenhum pet encontrado.</p>
      )}
    </div>
  )
}
