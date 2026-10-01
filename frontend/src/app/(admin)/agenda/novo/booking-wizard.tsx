'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { titleCase } from '@petshop/shared-types'
import type {
  CreditCheckResponse,
  ProfessionalResponse,
  ServiceResponse,
} from '@petshop/shared-types'
import { Badge, Button, Card, Field } from '@/components/ui'
import { useToast } from '@/components/toast'
import {
  availabilityAction,
  createAppointmentAction,
  creditCheckAction,
  getPetOptionAction,
  lastServicesAction,
  searchPetsAction,
  type ActionFailure,
  type PetOption,
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

function shortDate(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
  })
}

/** `YYYY-MM-DD` + n dias, sem passar por fuso: é aritmética de calendário. */
function addDays(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** 0 = domingo … 6 = sábado, do dia civil. */
function weekday(key: string): number {
  return new Date(`${key}T12:00:00.000Z`).getUTCDay()
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
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [pet, setPet] = useState<PetOption | null>(null)
  const [serviceIds, setServiceIds] = useState<string[]>([])
  const [professionalId, setProfessionalId] = useState<string>('')
  const [date, setDate] = useState(initialDate)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [nextAvailable, setNextAvailable] = useState<string | null>(null)
  // Até a primeira resposta chegar, o fuso do próprio navegador é o palpite menos
  // errado: quase sempre é o mesmo do petshop, e nada é exibido antes disso.
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [chosen, setChosen] = useState<Slot | null>(null)
  const [notes, setNotes] = useState('')
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  /** Data do atendimento de onde veio a sugestão de serviços; some quando a recepção mexe. */
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null)
  const slotsRequestId = useRef(0)
  /** A recepção já mexeu nos serviços deste pet: a sugestão atrasada não a atropela. */
  const servicesTouched = useRef(false)

  // O pet escolhido traz os serviços do último atendimento já marcados.
  useEffect(() => {
    servicesTouched.current = false
    setSuggestedFrom(null)
    if (!pet) return
    let active = true
    void lastServicesAction(pet.id).then((last) => {
      if (!active || !last || servicesTouched.current) return
      const activeIds = new Set(services.filter((item) => item.active).map((item) => item.id))
      const ids = last.serviceIds.filter((id) => activeIds.has(id))
      if (ids.length === 0) return
      setServiceIds(ids)
      setSuggestedFrom(last.startsAt)
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet?.id])

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
      // A grade é do conjunto escolhido: o servidor soma as durações e só oferece
      // quem executa todos os serviços. Até o MOD-PORTAL isto era uma aproximação —
      // o primeiro serviço definia a grade e a confirmação validava o resto.
      const result = await availabilityAction({
        serviceIds,
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
        toast('Horário marcado.')
        router.push(`/agenda/dia?date=${date}`)
        return
      }
      setFailure(result)
    })
  }

  // O preço é a linha do porte **deste** pet. Com o horário escolhido, vale o que o
  // servidor calculou para ele — é o mesmo número que vai ser lançado.
  const total =
    chosen?.priceCents ??
    chosenServices.reduce(
      (sum, service) =>
        sum + (service.pricing.find((item) => item.sizeId === pet?.sizeId)?.priceCents ?? 0),
      0,
    )

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
              <Button type="button" onClick={() => setPet(null)}>
                Trocar
              </Button>
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
                    on
                      ? 'border-accent bg-accent/10 text-fg'
                      : 'border-line text-subtle hover:text-fg'
                  }`}
                  onClick={() => {
                    servicesTouched.current = true
                    setSuggestedFrom(null)
                    setServiceIds((current) =>
                      on ? current.filter((id) => id !== service.id) : [...current, service.id],
                    )
                  }}
                >
                  {service.name}
                </button>
              )
            })}
          </div>
          {suggestedFrom && (
            <p className="hint mt-3">
              Os mesmos do último atendimento, em {shortDate(suggestedFrom, timezone)}. Ajuste se o
              cliente pedir outra coisa.
            </p>
          )}
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

            <DayShortcuts date={date} timezone={timezone} onPick={setDate} />

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
              Ninguém está habilitado em todos os serviços escolhidos. Ajuste as habilitações em
              Profissionais.
            </p>
          )}

          <div className="mt-4">
            {pending && slots === null ? (
              <p className="hint">Procurando horários…</p>
            ) : slots && slots.length > 0 ? (
              <SlotGrid
                slots={slots}
                chosen={chosen}
                showProfessionals={!professionalId}
                timezone={timezone}
                onChoose={setChosen}
              />
            ) : (
              <div className="hint">
                <p>Nenhum horário livre neste dia.</p>
                {nextAvailable && (
                  <Button
                    type="button"
                    className="mt-2"
                    onClick={() => setDate(dayKey(nextAvailable, timezone))}
                  >
                    Ir para {dayLabel(nextAvailable, timezone)}, às {hour(nextAvailable, timezone)}
                  </Button>
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

          {failure && (
            <GateBanner
              failure={failure}
              reason={overrideReason}
              onReason={setOverrideReason}
              onConfirm={confirm}
              pending={pending}
              timezone={timezone}
            />
          )}

          <div className="mt-5 flex justify-end">
            <Button type="button" busy={pending} onClick={() => confirm()} busyLabel="Marcando…">
              Marcar horário
            </Button>
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
        <Button
          type="button"
          className="mt-3"
          busy={pending}
          onClick={() => onConfirm({ acknowledgedAlerts: true })}
          busyLabel="Marcando…"
        >
          A equipe está ciente — marcar mesmo assim
        </Button>
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
        <Button
          type="button"
          className="mt-3"
          busy={pending}
          disabled={reason.trim().length < 10}
          onClick={() => onConfirm({ override: { reason: reason.trim() } })}
          busyLabel="Marcando…"
        >
          Liberar e marcar
        </Button>
      </div>
    )
  }

  return (
    <div className="card mt-4 border-danger/40 px-5 py-4" role="alert">
      <p className="font-medium">{failure.message}</p>
      {failure.suggestions && failure.suggestions.length > 0 && (
        <p className="hint mt-1">
          Horários próximos: {failure.suggestions.map((s) => hour(s.startsAt, timezone)).join(', ')}
        </p>
      )}
    </div>
  )
}

// ─── Peças ───────────────────────────────────────────────────────────────────

const PILL = 'rounded-full border px-3 py-1.5 text-sm transition-colors'
const PILL_ON = 'border-accent bg-accent/10 text-fg'
const PILL_OFF = 'border-line text-subtle hover:text-fg'

/**
 * Hoje, Amanhã e o próximo sábado — os três dias que o balcão mais marca, a um toque.
 * O calendário nativo continua ao lado para o resto. "Hoje" é o dia **do petshop**.
 */
function DayShortcuts({
  date,
  timezone,
  onPick,
}: {
  date: string
  timezone: string
  onPick: (date: string) => void
}) {
  const today = dayKey(new Date().toISOString(), timezone)
  const shortcuts = [
    { label: 'Hoje', value: today },
    { label: 'Amanhã', value: addDays(today, 1) },
  ]
  const untilSaturday = (6 - weekday(today) + 7) % 7
  // Sábado só quando não é hoje nem amanhã — aí ele já está na fila com o próprio nome.
  if (untilSaturday > 1) shortcuts.push({ label: 'Sábado', value: addDays(today, untilSaturday) })

  return (
    <div className="flex flex-wrap gap-2 pb-1" role="group" aria-label="Atalhos de dia">
      {shortcuts.map((item) => (
        <button
          key={item.label}
          type="button"
          aria-pressed={date === item.value}
          className={`${PILL} ${date === item.value ? PILL_ON : PILL_OFF}`}
          onClick={() => onPick(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A grade do dia, um botão por **horário** e agrupada por período.
 *
 * O servidor devolve um slot por par horário × profissional; com "Qualquer um
 * disponível", desenhar cada par era uma parede de botões em que o mesmo 10:00
 * aparecia quatro vezes. Aqui o horário aparece uma vez, e quem atende se escolhe
 * depois, numa linha só — já com o primeiro livre marcado, que é o "qualquer um".
 */
function SlotGrid({
  slots,
  chosen,
  showProfessionals,
  timezone,
  onChoose,
}: {
  slots: Slot[]
  chosen: Slot | null
  showProfessionals: boolean
  timezone: string
  onChoose: (slot: Slot) => void
}) {
  const byStart = new Map<string, Slot[]>()
  for (const slot of slots) {
    const group = byStart.get(slot.startsAt)
    if (group) group.push(slot)
    else byStart.set(slot.startsAt, [slot])
  }

  const periods = [
    { label: 'Manhã', starts: [] as string[] },
    { label: 'Tarde', starts: [] as string[] },
    { label: 'Noite', starts: [] as string[] },
  ]
  for (const startsAt of [...byStart.keys()].sort()) {
    const h = Number(hour(startsAt, timezone).slice(0, 2))
    periods[h < 12 ? 0 : h < 18 ? 1 : 2]!.starts.push(startsAt)
  }

  const sameHour = chosen ? (byStart.get(chosen.startsAt) ?? []) : []

  return (
    <div className="space-y-4">
      {periods
        .filter((period) => period.starts.length > 0)
        .map((period) => (
          <div key={period.label}>
            <p className="hint mb-2 text-xs font-medium uppercase tracking-wide">{period.label}</p>
            <div className="flex flex-wrap gap-2">
              {period.starts.map((startsAt) => {
                const group = byStart.get(startsAt)!
                const on = chosen?.startsAt === startsAt
                return (
                  <button
                    key={startsAt}
                    type="button"
                    aria-pressed={on}
                    className={`rounded-2xl border px-3 py-2 text-sm transition-colors ${
                      on ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/50'
                    }`}
                    onClick={() => {
                      if (!on) onChoose(group[0]!)
                    }}
                  >
                    <span className="font-medium">{hour(startsAt, timezone)}</span>
                    {showProfessionals && (
                      <span className="hint block text-xs">
                        {group.length === 1 ? group[0]!.professionalName : `${group.length} livres`}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

      {showProfessionals && chosen && sameHour.length > 1 && (
        <div>
          <p className="hint mb-2">Com quem, às {hour(chosen.startsAt, timezone)}:</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Profissional">
            {sameHour.map((slot) => {
              const on = slot.professionalId === chosen.professionalId
              return (
                <button
                  key={slot.professionalId}
                  type="button"
                  aria-pressed={on}
                  className={`${PILL} ${on ? PILL_ON : PILL_OFF}`}
                  onClick={() => onChoose(slot)}
                >
                  {slot.professionalName}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

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
      <h2 className="font-semibold">{titleCase(title)}</h2>
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
      const result = await getPetOptionAction(initialPetId)
      if (result.ok) onPick(result.data)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPetId])

  return (
    <div className="mt-3">
      <input
        className="field"
        placeholder="Pet, tutor ou telefone…"
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
