import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { Badge, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { PetDetailView } from './pet-detail'

/** Detalhe do pet (MOD-PET-01/02/04/05/07/08 e MOD-PRONT-03/04/05). */

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

  // A série de peso e o histórico de titularidade são do mesmo pet e da mesma tela;
  // buscá-los aqui evita que o cliente descubra depois que a aba estava vazia. Se
  // qualquer um falhar, o detalhe do pet ainda abre — nenhum dos dois é o assunto
  // principal da página.
  const [weights, transfers, album, safetyRecord] = await Promise.all([
    serverApi()
      .listPetWeights(id)
      .catch(() => []),
    serverApi()
      .listPetTransfers(id)
      .catch(() => []),
    // As URLs do álbum são assinadas e vencem em 15 minutos, por isso a página é
    // `force-dynamic`: uma versão cacheada serviria endereços mortos.
    serverApi()
      .listPetPhotos(id)
      .catch(() => ({ photos: [], quota: { used: 0, limit: null } })),
    serverApi()
      .getSafetyRecord(id)
      .catch(() => ({
        allergies: [],
        temperament: { current: null, history: [], hadRiskHistory: false },
        medicalAlerts: [],
        alerts: [],
      })),
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
        weights={weights}
        transfers={transfers}
        album={album}
        safetyRecord={safetyRecord}
        canUpdate={me.permissions.includes('pet:update')}
        canDelete={me.permissions.includes('pet:delete')}
        canWeigh={me.permissions.includes('pet:weigh')}
        canManageLifecycle={me.permissions.includes('pet:manage_lifecycle')}
        canUploadPhoto={me.permissions.includes('pet:upload_photo')}
        canWriteAlerts={me.permissions.includes('record:write_alerts')}
        canManageRecord={me.permissions.includes('record:write')}
        canWriteNotes={me.permissions.includes('record:write_notes')}
      />
    </div>
  )
}
