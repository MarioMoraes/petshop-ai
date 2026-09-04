import { notFound, redirect } from 'next/navigation'
import { Alert } from '@/components/ui'
import { AlertTriangleIcon } from '@/components/icons'
import { PortalFrame } from '../../../frame'
import { RescheduleForm } from './reschedule-form'
import { PortalError, readOwnAppointment, readPortalContext } from '@/lib/portal-api'

/**
 * Remarcar (AC-04 de MOD-PORTAL-06).
 *
 * Tela própria, e não um diálogo no cartão: escolher dia e horário é a mesma pergunta em
 * duas etapas do agendamento, e num celular ela não cabe numa folha inferior sem virar
 * rolagem dentro de rolagem.
 *
 * O pet e os serviços **não se escolhem aqui**. Remarcar é mudar o horário do que já
 * está combinado; trocar o serviço é outro agendamento, e o caminho para ele é cancelar
 * e marcar de novo — que é o que o domínio faria de qualquer jeito, já que o preço é
 * recalculado e a duração muda a grade.
 */

export const dynamic = 'force-dynamic'

export default async function PortalRemarcarPage({
  params,
}: {
  params: Promise<{ appointmentId: string }>
}) {
  const { appointmentId } = await params

  try {
    const [context, appointment] = await Promise.all([
      readPortalContext(),
      readOwnAppointment(appointmentId),
    ])

    if (!context.features.onlineBookingEnabled) {
      return (
        <PortalFrame
          tenantName={context.tenant.name}
          titulo="Remarcar"
          voltar={{ href: '/portal/agendamentos', label: 'Meus agendamentos' }}
        >
          <Alert tone="accent" icon={<AlertTriangleIcon />} title="Remarcar pelo site" role="status">
            O {context.tenant.name} não recebe alterações por aqui. Fale com a equipe para
            mudar o horário.
          </Alert>
        </PortalFrame>
      )
    }

    if (!appointment.actions.canReschedule) {
      return (
        <PortalFrame
          tenantName={context.tenant.name}
          titulo="Remarcar"
          voltar={{ href: '/portal/agendamentos', label: 'Meus agendamentos' }}
        >
          <Alert tone="accent" icon={<AlertTriangleIcon />} title="Não dá para remarcar" role="status">
            {appointment.status === 'CHECKED_IN' || appointment.status === 'IN_PROGRESS'
              ? 'Seu pet já está no petshop. Fale com a equipe para resolver.'
              : 'Este agendamento não pode mais ser alterado pelo site.'}
          </Alert>
        </PortalFrame>
      )
    }

    return (
      <PortalFrame
        tenantName={context.tenant.name}
        titulo="Remarcar"
        voltar={{ href: '/portal/agendamentos', label: 'Meus agendamentos' }}
        descricao={`${appointment.petName} · ${appointment.services.join(', ')}`}
      >
        <RescheduleForm appointment={appointment} />
      </PortalFrame>
    )
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    if (error instanceof PortalError && error.status === 404) notFound()
    throw error
  }
}
