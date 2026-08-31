import { notFound } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { PetForm } from '../../pet-form'

/** Edição de pet (MOD-PET-01). */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditarPetPage({ params }: PageProps) {
  const { id } = await params

  const pet = await serverApi()
    .getPet(id)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) notFound()
      throw error
    })

  // As raças da espécie atual já vão montadas: sem isso o seletor abriria vazio e
  // pareceria que a raça do pet foi perdida.
  const [species, sizes, coats, breeds] = await Promise.all([
    serverApi().listSpecies(),
    serverApi().listSizes(),
    serverApi().listCoats(),
    serverApi().listBreeds(pet.species.id),
  ])

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Cadastros · Pets" title={`Editar ${pet.name}`} />
      <PetForm species={species} sizes={sizes} coats={coats} initialBreeds={breeds} pet={pet} />
    </div>
  )
}
