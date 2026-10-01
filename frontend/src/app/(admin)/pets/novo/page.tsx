import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { PetForm } from '../pet-form'
import type { TutorOption } from '../actions'

/** Cadastro de pet (MOD-PET-01). */

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Novo pet — PetShop AI' }

interface PageProps {
  searchParams: Promise<{ tutorId?: string }>
}

export default async function NovoPetPage({ searchParams }: PageProps) {
  const { tutorId } = await searchParams

  // O catálogo é servido de cache com TTL de 24h: as três chamadas custam pouco e
  // deixam os seletores prontos antes de o atendente digitar a primeira letra.
  const [species, sizes, coats, initialTutor] = await Promise.all([
    serverApi().listSpecies(),
    serverApi().listSizes(),
    serverApi().listCoats(),
    loadTutor(tutorId),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cadastros · Pets"
        title="Novo pet"
        subtitle="Espécie, porte e responsável são o mínimo. O resto pode vir na próxima visita."
      />
      <PetForm species={species} sizes={sizes} coats={coats} initialTutor={initialTutor} />
    </div>
  )
}

/**
 * Quem chega da ficha do tutor (ou do "Salvar e cadastrar pet") já disse de quem é o
 * pet; buscá-lo de novo na seção de responsáveis é pedir o que a tela já sabe. Id
 * inválido ou tutor de outro tenant só deixa a seção vazia, como no cadastro avulso.
 */
async function loadTutor(tutorId: string | undefined): Promise<TutorOption | undefined> {
  if (!tutorId || !/^[0-9a-f-]{36}$/i.test(tutorId)) return undefined
  try {
    const tutor = await serverApi().getTutor(tutorId)
    return { id: tutor.id, displayName: tutor.displayName, phoneMasked: tutor.phoneMasked }
  } catch {
    return undefined
  }
}
