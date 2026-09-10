import { redirect } from 'next/navigation'
import { formatBRL, type PortalAppointment } from '@petshop/shared-types'
import { Badge, EmptyState, SectionHead } from '@/components/ui'
import { CalendarIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { PortalFrame } from '../frame'
import { RowChip, RowItem, RowMeta, RowStack, RowText } from '../list'
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
          <ButtonLink href="/portal/agendar" className="h-9">
            Marcar
          </ButtonLink>
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
              {/*
                Os próximos continuam **um cartão cada**, e não linhas de uma pilha: cada
                um carrega botões, o leva-e-traz e um diálogo de cancelamento. Espremer
                isso numa linha de lista faria a lista virar cartão de qualquer jeito, só
                que sem o respiro entre um compromisso e o outro.
              */}
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
            <section>
              {/*
                "Histórico", e não "já aconteceram": o cancelado de sexta que vem cai
                nesta seção e ainda não aconteceu. O rótulo precisa caber nos dois.
              */}
              <RowStack
                head={<SectionHead icon={<CalendarIcon />} tone="icon-time" title="Histórico" />}
              >
                {agenda.past.map((appointment) => (
                  <PastRow
                    key={appointment.id}
                    appointment={appointment}
                    timezone={agenda.timezone}
                  />
                ))}
              </RowStack>
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
 *
 * `RowItem` e não `RowLink`: daqui não se vai a lugar nenhum. Uma linha que levantasse
 * sob o dedo prometeria um detalhe que não existe.
 */
function PastRow({ appointment, timezone }: { appointment: PortalAppointment; timezone: string }) {
  const cancelado = appointment.status === 'CANCELLED'

  return (
    <RowItem>
      <RowChip icon={<CalendarIcon />} tone="icon-time" />

      <RowText
        title={dataHora(appointment.startsAt, timezone)}
        hint={`${appointment.petName} · ${appointment.services.join(', ')}`}
        strike={cancelado}
      />

      <RowMeta>
        {cancelado ? (
          <Badge tone="neutral">Cancelado</Badge>
        ) : appointment.status === 'NO_SHOW' ? (
          <Badge tone="danger">Não compareceu</Badge>
        ) : (
          formatBRL(appointment.totalCents)
        )}
      </RowMeta>
    </RowItem>
  )
}

/**
 * A data do histórico, curta.
 *
 * "14/08/2026 · 10:00" e não "14 de ago. de 2026, 10:00": a linha divide a largura com o
 * valor ou com o selo de cancelado, e a forma por extenso quebrava em duas linhas em
 * qualquer celular. É a mesma forma numérica do extrato, que é a outra lista de coisas
 * já acontecidas.
 */
function dataHora(instant: string, timeZone: string): string {
  const formatador = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
  const [data, hora] = formatador.format(new Date(instant)).split(', ')
  return `${data} · ${hora}`
}
