'use client'

import { useState, useTransition, type ReactNode } from 'react'
import {
  formatBRL,
  type DayAppointment,
  type ServiceResponse,
  type TaxiRideResponse,
} from '@petshop/shared-types'
import {
  AlertTriangleIcon,
  CalendarIcon,
  NoteIcon,
  PawPrintIcon,
  TrendingUpIcon,
  VanIcon,
} from '@/components/icons'
import { Modal } from '@/components/modal'
import { Alert, Badge, Choice, Field, FormError, SectionHead } from '@/components/ui'
import { horaDe, minutosNoFuso, STATUS_LABELS } from '@/lib/agenda-dia'
import { cancelAppointmentAction, checkInAction, checkOutAction } from '../actions'
import { TaxiPanel } from './taxi-panel'

/**
 * A ficha do atendimento.
 *
 * Antes desta entrega **não existia**. O que havia era um botão "Concluir" que abria
 * três campos espremidos dentro do cartão do dia, e nada mais: tutor, duração, valor e
 * status não apareciam em lugar nenhum da agenda, e `cancelAppointmentAction` estava
 * implementada em `../actions.ts` sem uma única tela que a chamasse — não dava para
 * cancelar um atendimento pela agenda.
 *
 * Quatro vistas na mesma janela, e a escolha de serem a mesma janela é o ponto: o
 * cabeçalho com o pet, o horário e o profissional **não muda** ao trocar de vista. O
 * erro que essa tela precisa impedir não é digitar o peso errado, é digitar o peso
 * certo na ficha do pet errado.
 *
 * Nenhuma regra de negócio mora aqui. A chave de idempotência do check-out continua
 * nascendo no servidor e a observação continua sendo gravada **antes** dele
 * (`../actions.ts`); o que este componente decide é só qual ação a tela oferece.
 */

export type Vista = 'ficha' | 'checkout' | 'taxi' | 'cancelar'

/**
 * Os status do agendamento que ainda aceitam pendurar uma corrida.
 *
 * Espelha `CHARGEABLE_APPOINTMENT_STATUSES` do taxidog-service: concluído e cancelado
 * ficam de fora porque o débito já foi (ou não vai) para o ledger, e um item
 * acrescentado depois nunca seria cobrado.
 */
const TAXI_ABLE = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'])

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  CONFIRMED: 'accent',
  CHECKED_IN: 'accent',
  IN_PROGRESS: 'accent',
  COMPLETED: 'success',
  NO_SHOW: 'danger',
  CANCELLED: 'neutral',
  RESCHEDULED: 'neutral',
}

interface Props {
  appointment: DayAppointment
  vistaInicial: Vista
  timezone: string
  professionalName: string
  services: ServiceResponse[]
  taxi: { windowMinutes: number } | null
  rides: TaxiRideResponse[]
  onClose: () => void
  onDone: () => void
}

export function AppointmentDialog({
  appointment,
  vistaInicial,
  timezone,
  professionalName,
  services,
  taxi,
  rides,
  onClose,
  onDone,
}: Props) {
  const [vista, setVista] = useState<Vista>(vistaInicial)
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startEnvio] = useTransition()

  const inicio = horaDe(minutosNoFuso(appointment.startsAt, timezone))
  const fim = horaDe(minutosNoFuso(appointment.endsAt, timezone))
  const criticos = appointment.alerts.filter((alerta) => alerta.severity === 'CRITICAL')

  const podeConcluir = appointment.status === 'CHECKED_IN' || appointment.status === 'IN_PROGRESS'
  const podeChegar = appointment.status === 'CONFIRMED'
  const podePedirTaxi = taxi !== null && TAXI_ABLE.has(appointment.status) && rides.length < 2
  const podeCancelar = TAXI_ABLE.has(appointment.status)

  function registrarChegada() {
    setErro(null)
    startEnvio(async () => {
      const resultado = await checkInAction(appointment.id)
      if (resultado.ok) onDone()
      else setErro(resultado.message)
    })
  }

  const cabecalho = {
    icon: <CalendarIcon />,
    tone: 'icon-time' as const,
    title: appointment.petName,
    subtitle: (
      <>
        {inicio}–{fim} · {professionalName} · {formatBRL(appointment.totalCents)}
      </>
    ),
  }

  // ─── Concluir ──────────────────────────────────────────────────────────────

  if (vista === 'checkout') {
    return (
      <CheckoutView
        appointment={appointment}
        services={services}
        cabecalho={cabecalho}
        criticos={criticos}
        onBack={vistaInicial === 'checkout' ? undefined : () => setVista('ficha')}
        onClose={onClose}
        onDone={onDone}
      />
    )
  }

  // ─── Taxi Dog ──────────────────────────────────────────────────────────────

  if (vista === 'taxi' && taxi) {
    return (
      <Modal
        {...cabecalho}
        eyebrow="Taxi Dog"
        open
        onClose={onClose}
        onBack={() => setVista('ficha')}
      >
        <TaxiPanel
          appointment={appointment}
          timezone={timezone}
          windowMinutes={taxi.windowMinutes}
          existing={rides}
          onClose={() => setVista('ficha')}
          onDone={onDone}
        />
      </Modal>
    )
  }

  // ─── Cancelar ──────────────────────────────────────────────────────────────

  if (vista === 'cancelar') {
    return (
      <CancelView
        appointment={appointment}
        cabecalho={cabecalho}
        onBack={() => setVista('ficha')}
        onClose={onClose}
        onDone={onDone}
      />
    )
  }

  // ─── Ficha ─────────────────────────────────────────────────────────────────

  return (
    <Modal
      {...cabecalho}
      eyebrow="Atendimento"
      open
      onClose={onClose}
      busy={enviando}
      /*
       * Só duas ações no rodapé, e uma delas é a principal.
       *
       * A primeira versão punha as quatro aqui e, com "Cancelar atendimento" e "Pedir a
       * outra perna" no mesmo lugar, o rodapé quebrava em duas linhas — e o botão que
       * de fato encerra o caso ia parar embaixo, no lugar onde ninguém procura. O
       * cancelamento desceu para o corpo, que é onde uma ação destrutiva deve estar:
       * alcançável, e não a um deslize do polegar da ação principal.
       */
      footer={
        <>
          {podePedirTaxi && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={enviando}
              onClick={() => setVista('taxi')}
            >
              {rides.length === 0 ? 'Taxi Dog' : 'Pedir a outra perna'}
            </button>
          )}
          {podeChegar && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={enviando}
              onClick={registrarChegada}
            >
              {enviando ? 'Registrando…' : 'Registrar chegada'}
            </button>
          )}
          {podeConcluir && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={enviando}
              onClick={() => setVista('checkout')}
            >
              Concluir atendimento
            </button>
          )}
          {!podeChegar && !podeConcluir && (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Fechar
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <CriticalAlerts alerts={criticos} />
        <FormError message={erro} />

        <div className="card space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Situação</p>
            <Badge tone={STATUS_TONE[appointment.status] ?? 'neutral'}>
              {STATUS_LABELS[appointment.status] ?? appointment.status}
            </Badge>
          </div>

          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Linha rotulo="Horário">
              {inicio}–{fim}
            </Linha>
            <Linha rotulo="Profissional">{professionalName}</Linha>
            <Linha rotulo="Serviços">{appointment.services.join(', ')}</Linha>
            <Linha rotulo="Valor">{formatBRL(appointment.totalCents)}</Linha>
          </dl>
        </div>

        {appointment.alerts.length > criticos.length && (
          <div>
            <p className="section-eyebrow">Alertas do pet</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {appointment.alerts
                .filter((alerta) => alerta.severity !== 'CRITICAL')
                .map((alerta) => (
                  <li key={alerta.label}>
                    <Badge tone="neutral">{alerta.label}</Badge>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {rides.length > 0 && (
          <div>
            <p className="section-eyebrow">Leva-e-traz</p>
            <ul className="mt-2 space-y-1.5">
              {rides.map((ride) => (
                <li key={ride.id} className="meta-pill">
                  <VanIcon />
                  <span>
                    {ride.legLabel} · {horaDe(minutosNoFuso(ride.windowStartsAt, timezone))} ·{' '}
                    {/* Sem motorista é a única situação que pede alguém agora. */}
                    {ride.status === 'REQUESTED' ? (
                      <span className="font-medium text-danger">sem motorista</span>
                    ) : (
                      ride.statusLabel
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {appointment.status === 'PENDING' && (
          <p className="hint">
            Este horário ainda aguarda aprovação. O check-in só é liberado depois que ele
            for confirmado.
          </p>
        )}

        {podeCancelar && (
          <div className="border-t border-line pt-4">
            <button
              type="button"
              className="text-sm text-subtle underline decoration-line underline-offset-4 hover:text-danger hover:decoration-danger"
              disabled={enviando}
              onClick={() => setVista('cancelar')}
            >
              Cancelar este horário
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Concluir o atendimento ──────────────────────────────────────────────────

interface Cabecalho {
  icon: ReactNode
  tone: 'icon-time'
  title: string
  subtitle: ReactNode
}

/**
 * O check-out.
 *
 * Três campos, e **nenhum obrigatório**. O balcão tem um cliente na frente esperando
 * para ir embora; um formulário que exige preenchimento vira preenchimento inventado,
 * que é pior que campo vazio — porque campo vazio ninguém confunde com informação.
 *
 * Os alertas críticos são repetidos aqui, e não só na ficha: quem chega direto pelo
 * botão "Concluir" não passou pela ficha, e a alergia do pet é a última coisa que pode
 * depender de o atendente ter clicado no lugar certo.
 */
function CheckoutView({
  appointment,
  services,
  cabecalho,
  criticos,
  onBack,
  onClose,
  onDone,
}: {
  appointment: DayAppointment
  services: ServiceResponse[]
  cabecalho: Cabecalho
  criticos: DayAppointment['alerts']
  onBack: (() => void) | undefined
  onClose: () => void
  onDone: () => void
}) {
  const [weight, setWeight] = useState('')
  const [observations, setObservations] = useState('')
  const [extras, setExtras] = useState<string[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startEnvio] = useTransition()

  const jaFeitos = new Set(appointment.services)
  const disponiveis = services.filter((service) => !jaFeitos.has(service.name))

  function confirmar() {
    setErro(null)
    const peso = weight.trim() ? Number(weight.replace(',', '.')) : undefined
    if (peso !== undefined && (Number.isNaN(peso) || peso <= 0)) {
      setErro('Peso inválido — use quilos, como 12,4')
      return
    }

    startEnvio(async () => {
      const result = await checkOutAction(appointment.id, {
        ...(peso === undefined ? {} : { weightKg: peso }),
        ...(observations.trim() ? { observations: observations.trim() } : {}),
        ...(extras.length > 0 ? { extraItems: extras.map((serviceId) => ({ serviceId })) } : {}),
      })
      if (result.ok) onDone()
      else setErro(result.message)
    })
  }

  return (
    <Modal
      {...cabecalho}
      eyebrow="Concluir atendimento"
      open
      onClose={onClose}
      onBack={onBack}
      busy={enviando}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={enviando} onClick={onClose}>
            Agora não
          </button>
          <button type="button" className="btn btn-primary" disabled={enviando} onClick={confirmar}>
            {enviando ? 'Concluindo…' : 'Concluir atendimento'}
          </button>
        </>
      }
    >
      <div className="space-y-6">
        <CriticalAlerts alerts={criticos} />

        <section className="space-y-3">
          <SectionHead
            icon={<TrendingUpIcon />}
            tone="icon-time"
            eyebrow="01 · Registro"
            title="Quanto o pet pesa hoje"
            description="Opcional. Entra na série do prontuário, que é o que mostra ganho ou perda ao longo dos meses."
          />
          <Field label="Peso de hoje" htmlFor={`peso-${appointment.id}`}>
            {/* `.field-tail` do sistema: a unidade dentro do campo dispensa repetir
                "(kg)" no rótulo e some com a dúvida entre quilo e grama. */}
            <span className="relative block">
              <input
                id={`peso-${appointment.id}`}
                className="field pr-11"
                inputMode="decimal"
                placeholder="12,4"
                autoComplete="off"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
              <span className="field-tail text-sm text-subtle">kg</span>
            </span>
          </Field>
        </section>

        <section className="space-y-3">
          <SectionHead
            icon={<NoteIcon />}
            tone="icon-time"
            eyebrow="02 · Como foi"
            title="O que aconteceu no atendimento"
            description="Fica no prontuário do pet e pode ser corrigido por 24 horas."
          />
          <Field label="Observações" htmlFor={`obs-${appointment.id}`}>
            <textarea
              id={`obs-${appointment.id}`}
              className="field min-h-24"
              placeholder="Ficou agitado no secador; não deixou cortar a unha traseira."
              value={observations}
              onChange={(event) => setObservations(event.target.value)}
            />
          </Field>
        </section>

        {disponiveis.length > 0 && (
          <section className="space-y-3">
            <SectionHead
              icon={<PawPrintIcon />}
              tone="icon-time"
              eyebrow="03 · Extras"
              title="Foi feito algo além do combinado"
              description="O item entra na conta do tutor pelo preço do porte deste pet."
            />
            <div className="grid gap-1.5 sm:grid-cols-2">
              {disponiveis.map((service) => (
                <Choice
                  key={service.id}
                  label={service.name}
                  checked={extras.includes(service.id)}
                  onChange={(marcado) =>
                    setExtras((atual) =>
                      marcado ? [...atual, service.id] : atual.filter((id) => id !== service.id),
                    )
                  }
                />
              ))}
            </div>
          </section>
        )}

        <FormError message={erro} />
      </div>
    </Modal>
  )
}

// ─── Cancelar o atendimento ──────────────────────────────────────────────────

/**
 * O cancelamento.
 *
 * `cancelAppointmentAction` existia desde o MOD-AGENDA e nunca teve tela — cancelar um
 * horário exigia mexer no banco. O motivo é opcional no serviço e **pedido aqui**: a
 * linha vira histórico do tutor, e "cancelado" sem porquê não responde à pergunta que
 * alguém vai fazer daqui a três meses.
 */
function CancelView({
  appointment,
  cabecalho,
  onBack,
  onClose,
  onDone,
}: {
  appointment: DayAppointment
  cabecalho: Cabecalho
  onBack: () => void
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [waiveFee, setWaiveFee] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startEnvio] = useTransition()

  function confirmar() {
    setErro(null)
    startEnvio(async () => {
      const resultado = await cancelAppointmentAction(appointment.id, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(waiveFee ? { waiveFee: true } : {}),
      })
      if (resultado.ok) onDone()
      else setErro(resultado.message)
    })
  }

  return (
    <Modal
      {...cabecalho}
      eyebrow="Cancelar atendimento"
      open
      onClose={onClose}
      onBack={onBack}
      busy={enviando}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={enviando} onClick={onBack}>
            Manter o horário
          </button>
          <button type="button" className="btn btn-primary" disabled={enviando} onClick={confirmar}>
            {enviando ? 'Cancelando…' : 'Confirmar cancelamento'}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="O horário é liberado na hora">
          Outro pet pode ser marcado neste intervalo assim que você confirmar, e o
          cancelamento não se desfaz — remarcar é criar um agendamento novo.
        </Alert>

        <Field
          label="Por que está sendo cancelado"
          htmlFor={`motivo-${appointment.id}`}
          hint="Fica no histórico do tutor. Opcional, mas é o que responde a pergunta daqui a três meses."
        >
          <textarea
            id={`motivo-${appointment.id}`}
            className="field min-h-20"
            placeholder="O tutor ligou avisando que o pet passou mal."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        <Choice
          label="Isentar a taxa de cancelamento"
          description="Marque quando o cancelamento não é responsabilidade do tutor."
          checked={waiveFee}
          onChange={setWaiveFee}
        />

        <FormError message={erro} />
      </div>
    </Modal>
  )
}

// ─── Peças comuns ────────────────────────────────────────────────────────────

/**
 * Alerta clínico crítico.
 *
 * Aparece em todas as vistas que agem sobre o pet. Repetição de propósito: um alerta
 * que só existe numa vista é um alerta que depende de a pessoa ter passado por ela.
 */
function CriticalAlerts({ alerts }: { alerts: DayAppointment['alerts'] }) {
  if (alerts.length === 0) return null

  return (
    <Alert
      tone="danger"
      icon={<AlertTriangleIcon />}
      title={alerts.length === 1 ? 'Atenção com este pet' : `${alerts.length} alertas críticos`}
    >
      <ul className="space-y-0.5">
        {alerts.map((alerta) => (
          <li key={alerta.label}>{alerta.label}</li>
        ))}
      </ul>
    </Alert>
  )
}

function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div>
      <dt className="section-eyebrow">{rotulo}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  )
}
