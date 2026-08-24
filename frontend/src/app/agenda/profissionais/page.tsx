import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { AgendaTabs } from '../agenda-tabs'
import { ProfessionalsManager } from './professionals-manager'

/**
 * Profissionais e jornada (MOD-AGENDA-02).
 *
 * A tela responde a duas perguntas que a agenda vai fazer a cada agendamento: quem
 * pode executar este serviço, e este horário cabe na semana dessa pessoa. O resto —
 * cor da coluna, capacidade — é ajuste fino.
 */

export const dynamic = 'force-dynamic'

export default async function ProfissionaisPage() {
  const [professionals, services] = await Promise.all([
    serverApi().listProfessionals(true),
    serverApi().listServices(true),
  ])

  const active = professionals.filter((person) => person.active)
  const semJornada = active.filter((person) => person.schedule.length === 0).length

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agenda"
        title="Profissionais"
        subtitle={
          semJornada > 0
            ? `${semJornada} ${semJornada === 1 ? 'pessoa está' : 'pessoas estão'} sem jornada definida`
            : `${active.length} ${active.length === 1 ? 'pessoa atendendo' : 'pessoas atendendo'}`
        }
      />

      <AgendaTabs />

      <ProfessionalsManager professionals={professionals} services={services} />
    </div>
  )
}
