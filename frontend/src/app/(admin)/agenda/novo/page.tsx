import { NON_ATTENDING_ROLE_KEYS } from '@petshop/shared-types'
import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { AgendaTabs } from '../agenda-tabs'
import { BookingWizard } from './booking-wizard'

/**
 * Marcar horário (MOD-AGENDA-04).
 *
 * O catálogo é carregado no servidor e entregue pronto: serviços e profissionais mudam
 * quase nunca, e buscá-los no cliente adicionaria dois estados de carregamento a uma
 * tela que a recepção usa com o cliente esperando na frente.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ date?: string; petId?: string }>
}

export default async function NovoAgendamentoPage({ searchParams }: PageProps) {
  const params = await searchParams

  const [services, todos] = await Promise.all([
    serverApi().listServices(),
    serverApi().listProfessionals(),
  ])

  /*
   * O motorista sai do seletor de "quem atende": ele é um `professionals` por decisão
   * do Taxi Dog, mas corrida não é agendamento. A rota de disponibilidade já o exclui;
   * tirá-lo aqui evita oferecer um nome que nunca teria horário para mostrar.
   */
  const professionals = todos.filter(
    (pessoa) => !(NON_ATTENDING_ROLE_KEYS as readonly string[]).includes(pessoa.roleKey),
  )

  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '')
    ? params.date!
    : new Date().toISOString().slice(0, 10)

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Agenda" title="Marcar horário" />

      <AgendaTabs />

      <BookingWizard
        services={services}
        professionals={professionals}
        initialDate={date}
        initialPetId={params.petId ?? null}
      />
    </div>
  )
}
