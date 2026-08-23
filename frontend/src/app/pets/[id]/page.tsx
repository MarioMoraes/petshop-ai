import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { Badge, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { PetDetailView } from './pet-detail'

/** Detalhe do pet (MOD-PET-01 e MOD-PET-02). */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function PetPage({ params }: PageProps) {
  const { id } = await params

  const [pet, me] = await Promise.all([
    serverApi()
      .getPet(id)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) notFound()
        throw error
      }),
    serverApi().me(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/pets" className="hover:underline">
            ← Pets
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {pet.name}
            {pet.status === 'INACTIVE' && <Badge>Inativo</Badge>}
            {pet.status === 'DECEASED' && <Badge tone="danger">Falecido</Badge>}
            {pet.status === 'TRANSFERRED_OUT' && <Badge>Transferido</Badge>}
          </span>
        }
        subtitle={[pet.species.label, pet.breed?.label, pet.size.label, pet.ageLabel]
          .filter(Boolean)
          .join(' · ')}
      />

      <PetDetailView
        pet={pet}
        canUpdate={me.permissions.includes('pet:update')}
        canDelete={me.permissions.includes('pet:delete')}
      />
    </div>
  )
}
