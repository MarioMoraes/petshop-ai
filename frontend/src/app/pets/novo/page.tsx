import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { PetForm } from '../pet-form'

/** Cadastro de pet (MOD-PET-01). */

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Novo pet — PetShop AI' }

export default async function NovoPetPage() {
  // O catálogo é servido de cache com TTL de 24h: as três chamadas custam pouco e
  // deixam os seletores prontos antes de o atendente digitar a primeira letra.
  const [species, sizes, coats] = await Promise.all([
    serverApi().listSpecies(),
    serverApi().listSizes(),
    serverApi().listCoats(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cadastros · Pets"
        title="Novo pet"
        subtitle="Espécie, porte e responsável são o mínimo. O resto pode vir na próxima visita."
      />
      <PetForm species={species} sizes={sizes} coats={coats} />
    </div>
  )
}
