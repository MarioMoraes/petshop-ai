import { redirect } from 'next/navigation'
import { Alert, Card } from '@/components/ui'
import { AlertTriangleIcon } from '@/components/icons'
import { PortalFrame } from '../frame'
import { BookingWizard } from './booking-wizard'
import { PortalError, readOwnPets, readPortalContext } from '@/lib/portal-api'

/**
 * Marcar horário (MOD-PORTAL-05).
 *
 * A tela **não existe** com o agendamento online desligado (AC-07) — e quem chegar por
 * um link antigo encontra a explicação, não um 403 cru. O que garante a regra é o
 * servidor: as três rotas do agendamento respondem 403 mesmo chamadas direto, e esta
 * página é só a cortesia de dizer por quê.
 *
 * Pet falecido não entra na lista: o AC-05 de MOD-PORTAL-03 tira o botão de agendar da
 * ficha dele, e deixá-lo aqui devolveria pela porta dos fundos o que a ficha já negou.
 */

export const dynamic = 'force-dynamic'

export default async function PortalAgendarPage() {
  let context
  let pets
  try {
    ;[context, pets] = await Promise.all([readPortalContext(), readOwnPets()])
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  const agendaveis = pets.pets.filter((pet) => !pet.inMemoriam)

  if (!context.features.onlineBookingEnabled) {
    return (
      <PortalFrame
        tenantName={context.tenant.name}
        titulo="Marcar horário"
        voltar={{ href: '/portal/inicio', label: 'Início' }}
      >
        <Alert tone="accent" icon={<AlertTriangleIcon />} title="Agendamento pelo site" role="status">
          O {context.tenant.name} não recebe agendamentos por aqui. Fale com a equipe para
          marcar o horário do seu pet.
        </Alert>
      </PortalFrame>
    )
  }

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Marcar horário"
      voltar={{ href: '/portal/inicio', label: 'Início' }}
      descricao={
        context.features.onlineBookingRequiresApproval
          ? 'O horário fica reservado e o estabelecimento confirma em seguida.'
          : undefined
      }
    >
      {agendaveis.length === 0 ? (
        <Card>
          <p className="hint">
            Não há pet disponível para agendar. Fale com o {context.tenant.name}.
          </p>
        </Card>
      ) : (
        <BookingWizard pets={agendaveis} tenantName={context.tenant.name} />
      )}
    </PortalFrame>
  )
}
