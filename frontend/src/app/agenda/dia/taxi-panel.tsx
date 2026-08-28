'use client'

import { useEffect, useState, useTransition } from 'react'
import type {
  AddressResponse,
  DayAppointment,
  TaxiAddressInput,
  TaxiLeg,
  TaxiQuote,
  TaxiRideResponse,
} from '@petshop/shared-types'
import { Badge, Field, FormError } from '@/components/ui'
import { lookupCepAction } from '@/app/tutores/actions'
import {
  createRidesAction,
  taxiQuoteAction,
  tutorPrimaryAddressAction,
} from '@/app/taxi/actions'

/**
 * Pedir o leva-e-traz para um atendimento que já existe (MOD-TAXI-01 e 02).
 *
 * A corrida nasce **do agendamento**, nunca sozinha: é a regra RN-01, e é também o
 * motivo de este painel morar na Agenda do Dia em vez do painel do Taxi Dog. Quem
 * decide buscar o pet é quem está olhando o banho marcado — e nesse instante o
 * agendamento, o pet, o tutor e o horário já estão todos na tela.
 *
 * Três coisas o painel resolve antes de deixar confirmar:
 *
 * 1. **A janela sai do próprio atendimento.** A coleta termina quando o banho começa;
 *    a entrega começa quando ele termina. São exatamente os limites que o servidor
 *    checa (AC-03), e pré-preenchê-los evita que a recepção descubra a incoerência
 *    depois de já ter prometido o horário ao tutor.
 * 2. **O endereço aparece antes de virar corrida.** Herdado, ele é copiado cifrado e
 *    congelado — o motorista vai para onde este texto diz. A recepção é a última
 *    pessoa com chance de notar que o tutor se mudou.
 * 3. **O preço aparece antes de entrar na conta.** A corrida vira um item do
 *    agendamento (RN-05) e o tutor vai pagar por ela no fechamento; cobrar sem ter
 *    mostrado é o tipo de surpresa que volta como reclamação no balcão.
 *
 * O motorista **não** se escolhe aqui. A corrida nasce em `REQUESTED`, na fila sem
 * dono do painel do Taxi Dog, que é onde está a informação para decidir — quem já
 * tem quantos pets na van naquela janela.
 */

interface Props {
  appointment: DayAppointment
  /** Fuso do estabelecimento (RN-12): "8h" é a hora do petshop, não a do navegador. */
  timezone: string
  /** `defaultWindowMinutes` da configuração do módulo. */
  windowMinutes: number
  /** Corridas vivas que este agendamento já tem — uma perna por agendamento (AC-04). */
  existing: TaxiRideResponse[]
  onClose: () => void
  onDone: () => void
}

const EMPTY_ADDRESS = {
  zipCode: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
  accessNotes: '',
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** Hora local do estabelecimento, no formato que o `<input type="time">` aceita. */
function localTime(instant: Date | string, timezone: string): string {
  return new Date(instant).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  })
}

function minutesOf(hhmm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * O erro de um campo, venha ele com o caminho curto ou com o caminho do array.
 *
 * As duas formas chegam de verdade: a checagem de coerência da janela devolve
 * `windowEndsAt` cru (é regra de negócio, escrita à mão no serviço), enquanto o zod do
 * corpo devolve `legs.0.address.street`. Procurar só pela forma curta deixaria metade
 * dos erros do endereço sem aparecer ao lado do campo — e a recepção reenviando o
 * mesmo formulário sem entender o que falta.
 */
function erroDe(fieldErrors: Record<string, string>, name: string): string | undefined {
  if (fieldErrors[name]) return fieldErrors[name]
  const sufixo = Object.keys(fieldErrors).find((key) => key.endsWith(`.${name}`))
  return sufixo ? fieldErrors[sufixo] : undefined
}

/**
 * "HH:MM" local → instante ISO.
 *
 * Convertido por **deslocamento a partir do próprio atendimento**, não montando uma
 * data com o fuso do navegador: a recepção pode estar num fuso diferente do
 * estabelecimento, e o horário do agendamento é a única âncora que já vem correta do
 * servidor. Como a janela e o atendimento são do mesmo dia, o delta de relógio é
 * exato — inclusive na virada do horário de verão, que o instante de referência já
 * carrega resolvida.
 */
function isoAtLocalTime(reference: string, timezone: string, hhmm: string): string | null {
  const target = minutesOf(hhmm)
  const anchor = minutesOf(localTime(reference, timezone))
  if (target === null || anchor === null) return null
  return new Date(new Date(reference).getTime() + (target - anchor) * 60_000).toISOString()
}

function shifted(instant: string, minutes: number, timezone: string): string {
  return localTime(new Date(new Date(instant).getTime() + minutes * 60_000), timezone)
}

export function TaxiPanel({
  appointment,
  timezone,
  windowMinutes,
  existing,
  onClose,
  onDone,
}: Props) {
  const liveLegs = new Set(existing.map((ride) => ride.leg))

  // A ida vem marcada por padrão porque é o pedido comum. Quando ela já existe — o
  // botão do cartão diz "Pedir a outra perna" —, o painel abre já na volta: reabrir
  // num formulário sem nada marcado faria o atendente procurar o que clicar.
  const [pickup, setPickup] = useState(!liveLegs.has('PICKUP'))
  const [dropoff, setDropoff] = useState(liveLegs.has('PICKUP') && !liveLegs.has('DROPOFF'))

  // A coleta termina quando o atendimento começa; a entrega começa quando ele acaba.
  const [pickupStart, setPickupStart] = useState(
    shifted(appointment.startsAt, -windowMinutes, timezone),
  )
  const [pickupEnd, setPickupEnd] = useState(localTime(appointment.startsAt, timezone))
  const [dropoffStart, setDropoffStart] = useState(localTime(appointment.endsAt, timezone))
  const [dropoffEnd, setDropoffEnd] = useState(
    shifted(appointment.endsAt, windowMinutes, timezone),
  )

  const [mode, setMode] = useState<'inherit' | 'custom'>('inherit')
  const [address, setAddress] = useState(EMPTY_ADDRESS)
  const [primary, setPrimary] = useState<AddressResponse | null>(null)
  const [loadingAddress, setLoadingAddress] = useState(true)
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'notfound'>('idle')

  const [notes, setNotes] = useState('')
  const [quote, setQuote] = useState<TaxiQuote | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [enviando, startEnvio] = useTransition()

  // ─── Endereço herdado ──────────────────────────────────────────────────────

  useEffect(() => {
    let ativo = true
    void tutorPrimaryAddressAction(appointment.tutorId).then((found) => {
      if (!ativo) return
      setPrimary(found)
      setLoadingAddress(false)
      // Sem endereço principal não há o que herdar: o formulário abre já no manual,
      // que é o único caminho que leva a uma corrida (ERR_TAXI_003).
      if (!found) setMode('custom')
      else void taxiQuoteAction(found.zipCode).then((price) => ativo && setQuote(price))
    })
    return () => {
      ativo = false
    }
  }, [appointment.tutorId])

  function handleCepBlur() {
    const digits = address.zipCode.replace(/\D/g, '')
    if (digits.length !== 8) return

    setCepStatus('loading')
    void lookupCepAction(digits).then((found) => {
      setCepStatus(found ? 'idle' : 'notfound')
      if (found) {
        setAddress((current) => ({
          ...current,
          street: found.street || current.street,
          district: found.district || current.district,
          city: found.city,
          state: found.state,
        }))
      }
    })
    void taxiQuoteAction(digits).then(setQuote)
  }

  // ─── Envio ─────────────────────────────────────────────────────────────────

  const selecionadas: TaxiLeg[] = [
    ...(pickup ? (['PICKUP'] as const) : []),
    ...(dropoff ? (['DROPOFF'] as const) : []),
  ]

  function confirmar() {
    setErro(null)
    setFieldErrors({})

    if (selecionadas.length === 0) {
      setErro('Escolha ida, volta ou as duas')
      return
    }

    const custom =
      mode === 'custom'
        ? {
            zipCode: address.zipCode.replace(/\D/g, ''),
            street: address.street.trim(),
            number: address.number.trim(),
            ...(address.complement.trim() ? { complement: address.complement.trim() } : {}),
            district: address.district.trim(),
            city: address.city.trim(),
            state: address.state.trim().toUpperCase(),
            ...(address.accessNotes.trim() ? { accessNotes: address.accessNotes.trim() } : {}),
          }
        : undefined

    const janelas: Record<TaxiLeg, { reference: string; start: string; end: string }> = {
      PICKUP: { reference: appointment.startsAt, start: pickupStart, end: pickupEnd },
      DROPOFF: { reference: appointment.endsAt, start: dropoffStart, end: dropoffEnd },
    }

    const legs: {
      leg: TaxiLeg
      windowStartsAt: string
      windowEndsAt: string
      address?: TaxiAddressInput
      notes?: string
    }[] = []
    for (const leg of selecionadas) {
      const { reference, start, end } = janelas[leg]
      const windowStartsAt = isoAtLocalTime(reference, timezone, start)
      const windowEndsAt = isoAtLocalTime(reference, timezone, end)
      if (!windowStartsAt || !windowEndsAt) {
        setErro('Horário da janela inválido')
        return
      }
      legs.push({
        leg,
        windowStartsAt,
        windowEndsAt,
        ...(custom ? { address: custom } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
    }

    startEnvio(async () => {
      const result = await createRidesAction({ appointmentId: appointment.id, legs })
      if (result.ok) {
        onDone()
        return
      }
      setErro(result.message)
      setFieldErrors(result.fieldErrors)
    })
  }

  // ─── Tela ──────────────────────────────────────────────────────────────────

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Taxi Dog</h3>
        {quote && (
          <Badge tone="neutral">
            {money(quote.priceCents)} por perna
            {quote.zone?.name ? ` · ${quote.zone.name}` : ''}
          </Badge>
        )}
      </div>

      {/* ─── Pernas ─────────────────────────────────────────────────────── */}

      <fieldset className="space-y-3">
        <legend className="hint mb-1.5">O que o motorista faz</legend>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pickup}
              disabled={liveLegs.has('PICKUP')}
              onChange={(event) => setPickup(event.target.checked)}
            />
            <span>
              Buscar o pet (ida)
              {liveLegs.has('PICKUP') && <span className="hint"> — já pedida</span>}
            </span>
          </label>

          {pickup && (
            <div className="ml-6 flex flex-wrap items-center gap-2">
              <input
                type="time"
                aria-label="Início da janela de coleta"
                className="field w-32"
                value={pickupStart}
                onChange={(event) => setPickupStart(event.target.value)}
              />
              <span className="hint">até</span>
              <input
                type="time"
                aria-label="Fim da janela de coleta"
                className="field w-32"
                value={pickupEnd}
                onChange={(event) => setPickupEnd(event.target.value)}
              />
              <span className="hint">
                o atendimento começa {localTime(appointment.startsAt, timezone)}
              </span>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={dropoff}
              disabled={liveLegs.has('DROPOFF')}
              onChange={(event) => setDropoff(event.target.checked)}
            />
            <span>
              Levar de volta (volta)
              {liveLegs.has('DROPOFF') && <span className="hint"> — já pedida</span>}
            </span>
          </label>

          {dropoff && (
            <div className="ml-6 flex flex-wrap items-center gap-2">
              <input
                type="time"
                aria-label="Início da janela de entrega"
                className="field w-32"
                value={dropoffStart}
                onChange={(event) => setDropoffStart(event.target.value)}
              />
              <span className="hint">até</span>
              <input
                type="time"
                aria-label="Fim da janela de entrega"
                className="field w-32"
                value={dropoffEnd}
                onChange={(event) => setDropoffEnd(event.target.value)}
              />
              <span className="hint">
                o atendimento termina {localTime(appointment.endsAt, timezone)}
              </span>
            </div>
          )}
        </div>

        {(erroDe(fieldErrors, 'windowEndsAt') ?? erroDe(fieldErrors, 'windowStartsAt')) && (
          <p className="error-text" role="alert">
            {erroDe(fieldErrors, 'windowEndsAt') ?? erroDe(fieldErrors, 'windowStartsAt')}
          </p>
        )}
      </fieldset>

      {/* ─── Endereço ───────────────────────────────────────────────────── */}

      <div className="space-y-2">
        <p className="hint">Onde o motorista vai</p>

        {loadingAddress ? (
          <p className="hint">Carregando o endereço do tutor…</p>
        ) : (
          <>
            {primary ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  className="mt-1"
                  checked={mode === 'inherit'}
                  onChange={() => {
                    setMode('inherit')
                    void taxiQuoteAction(primary.zipCode).then(setQuote)
                  }}
                />
                <span>
                  {primary.street}, {primary.number}
                  {primary.complement ? ` — ${primary.complement}` : ''}
                  <span className="hint">
                    {' '}
                    · {primary.district}, {primary.city}/{primary.state} · {primary.zipCode}
                  </span>
                </span>
              </label>
            ) : (
              <p className="error-text" role="alert">
                Este tutor não tem endereço principal cadastrado. Informe abaixo para onde
                o motorista deve ir.
              </p>
            )}

            {primary && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === 'custom'}
                  onChange={() => setMode('custom')}
                />
                <span>Buscar em outro endereço</span>
              </label>
            )}

            {mode === 'custom' && (
              <div className="ml-6 grid gap-2 sm:grid-cols-2">
                <Field
                  label="CEP"
                  htmlFor={`cep-${appointment.id}`}
                  error={erroDe(fieldErrors, 'address.zipCode')}
                  hint={
                    cepStatus === 'loading'
                      ? 'Buscando…'
                      : cepStatus === 'notfound'
                        ? 'CEP não encontrado — preencha no braço'
                        : undefined
                  }
                >
                  <input
                    id={`cep-${appointment.id}`}
                    className="field"
                    inputMode="numeric"
                    placeholder="01310100"
                    value={address.zipCode}
                    onChange={(event) =>
                      setAddress((c) => ({ ...c, zipCode: event.target.value }))
                    }
                    onBlur={handleCepBlur}
                  />
                </Field>

                <Field
                  label="Número"
                  htmlFor={`num-${appointment.id}`}
                  error={erroDe(fieldErrors, 'address.number')}
                >
                  <input
                    id={`num-${appointment.id}`}
                    className="field"
                    value={address.number}
                    onChange={(event) =>
                      setAddress((c) => ({ ...c, number: event.target.value }))
                    }
                  />
                </Field>

                <Field
                  label="Rua"
                  htmlFor={`rua-${appointment.id}`}
                  error={erroDe(fieldErrors, 'address.street')}
                >
                  <input
                    id={`rua-${appointment.id}`}
                    className="field"
                    value={address.street}
                    onChange={(event) =>
                      setAddress((c) => ({ ...c, street: event.target.value }))
                    }
                  />
                </Field>

                <Field label="Complemento" htmlFor={`compl-${appointment.id}`}>
                  <input
                    id={`compl-${appointment.id}`}
                    className="field"
                    value={address.complement}
                    onChange={(event) =>
                      setAddress((c) => ({ ...c, complement: event.target.value }))
                    }
                  />
                </Field>

                <Field
                  label="Bairro"
                  htmlFor={`bairro-${appointment.id}`}
                  error={erroDe(fieldErrors, 'address.district')}
                >
                  <input
                    id={`bairro-${appointment.id}`}
                    className="field"
                    value={address.district}
                    onChange={(event) =>
                      setAddress((c) => ({ ...c, district: event.target.value }))
                    }
                  />
                </Field>

                <div className="grid grid-cols-[1fr_5rem] gap-2">
                  <Field
                    label="Cidade"
                    htmlFor={`cidade-${appointment.id}`}
                    error={erroDe(fieldErrors, 'address.city')}
                  >
                    <input
                      id={`cidade-${appointment.id}`}
                      className="field"
                      value={address.city}
                      onChange={(event) =>
                        setAddress((c) => ({ ...c, city: event.target.value }))
                      }
                    />
                  </Field>
                  <Field
                    label="UF"
                    htmlFor={`uf-${appointment.id}`}
                    error={erroDe(fieldErrors, 'address.state')}
                  >
                    <input
                      id={`uf-${appointment.id}`}
                      className="field"
                      maxLength={2}
                      value={address.state}
                      onChange={(event) =>
                        setAddress((c) => ({ ...c, state: event.target.value }))
                      }
                    />
                  </Field>
                </div>

                <div className="sm:col-span-2">
                  <Field
                    label="Como chegar"
                    htmlFor={`acesso-${appointment.id}`}
                    hint="Portaria, cachorro solto no quintal, tocar a campainha do fundo"
                  >
                    <input
                      id={`acesso-${appointment.id}`}
                      className="field"
                      value={address.accessNotes}
                      onChange={(event) =>
                        setAddress((c) => ({ ...c, accessNotes: event.target.value }))
                      }
                    />
                  </Field>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Recado e preço ─────────────────────────────────────────────── */}

      <Field
        label="Recado para o motorista"
        htmlFor={`taxi-obs-${appointment.id}`}
        hint="Opcional — vai junto na rota, no celular de quem dirige"
      >
        <input
          id={`taxi-obs-${appointment.id}`}
          className="field"
          placeholder="A tutora sai 8h; falar com a filha."
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>

      {quote && selecionadas.length > 0 && (
        <p className="hint">
          {selecionadas.length === 1
            ? `${money(quote.priceCents)} entram na conta deste atendimento.`
            : `${money(quote.priceCents)} × 2 pernas = ${money(quote.priceCents * 2)} na conta deste atendimento.`}
          {quote.priceSource === 'DEFAULT' && ' Preço padrão: o CEP não caiu em nenhuma zona.'}
        </p>
      )}

      <FormError message={erro} />

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={enviando} onClick={confirmar}>
          {enviando ? 'Pedindo…' : 'Pedir corrida'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={enviando} onClick={onClose}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
