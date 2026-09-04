import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatBRL, type PortalAppointment } from '@petshop/shared-types'
import { Badge, Card, EmptyState } from '@/components/ui'
import { PortalFrame } from '../frame'
import { AppointmentCard } from './appointment-card'
import { PortalError, readOwnAppointments, readPortalContext } from '@/lib/portal-api'

/**
 * Meus agendamentos (MOD-PORTAL-06).
 *
 * Duas seções numa tela só, e não duas abas: o tutor típico tem dois compromissos
 * futuros e uma dúzia de passados. Uma aba esconderia metade do conteúdo atrás de um
 * toque para separar coisas que ninguém confunde — o que já aconteceu está no passado, e
 * está escrito na data.
 *
 * O futuro vem inteiro e o passado paginado, como o servidor manda: quem tem trinta
 * agendamentos marcados não existe, e cortar a lista esconderia o de dezembro.
 */

export const dynamic = 'force-dynamic'

export default async function PortalAgendamentosPage() {
  let context
  let agenda
  try {
    ;[context, agenda] = await Promise.all([readPortalContext(), readOwnAppointments()])
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  const vazio = agenda.upcoming.length === 0 && agenda.past.length === 0

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Meus agendamentos"
      voltar={{ href: '/portal/inicio', label: 'Início' }}
      acao={
        context.features.onlineBookingEnabled ? (
          <Link href="/portal/agendar" className="btn btn-primary h-9">
            Marcar
          </Link>
        ) : undefined
      }
    >
      {vazio ? (
        <EmptyState
          title="Nenhum horário por aqui"
          description={
            context.features.onlineBookingEnabled
              ? 'Quando você marcar um horário, ele aparece nesta tela.'
              : `Fale com o ${context.tenant.name} para marcar o horário do seu pet.`
          }
        />
      ) : (
        <>
          {agenda.upcoming.length > 0 && (
            <section className="flex flex-col gap-3">
              <p className="section-eyebrow">Próximos</p>
              {agenda.upcoming.map((appointment) => (
                <AppointmentCard
                  key={appointment.id}
                  appointment={appointment}
                  actions={appointment.actions}
                  timezone={agenda.timezone}
                />
              ))}
            </section>
          )}

          {agenda.past.length > 0 && (
            <section className="flex flex-col gap-3">
              {/*
                "Histórico", e não "já aconteceram": o cancelado de sexta que vem cai
                nesta seção e ainda não aconteceu. O rótulo precisa caber nos dois.
              */}
              <p className="section-eyebrow">Histórico</p>
              {agenda.past.map((appointment) => (
                <PastCard
                  key={appointment.id}
                  appointment={appointment}
                  timezone={agenda.timezone}
                />
              ))}
            </section>
          )}
        </>
      )}
    </PortalFrame>
  )
}

/**
 * O que já passou.
 *
 * Sem botões, e o cancelado **aparece** em vez de sumir: o tutor lembra de ter marcado
 * aquele dia, e uma lista que nega o que ele lembra faz duvidar da tela inteira. É a
 * mesma decisão do atendimento anulado na linha do tempo do pet.
 */
function PastCard({
  appointment,
  timezone,
}: {
  appointment: PortalAppointment
  timezone: string
}) {
  const cancelado = appointment.status === 'CANCELLED'

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-sm font-medium ${cancelado ? 'text-muted line-through' : ''}`}>
            {dataHora(appointment.startsAt, timezone)}
          </p>
          <p className="hint mt-0.5">
            {appointment.petName} · {appointment.services.join(', ')}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {cancelado ? (
            <Badge tone="neutral">Cancelado</Badge>
          ) : appointment.status === 'NO_SHOW' ? (
            <Badge tone="danger">Não compareceu</Badge>
          ) : (
            <p className="text-sm font-medium">{formatBRL(appointment.totalCents)}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

function dataHora(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}
