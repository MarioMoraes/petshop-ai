import { notFound } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { PetAvatar } from '@/components/pet-avatar'
import { Badge } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { RecordHero } from '@/components/record-hero'
import { topAlert } from '@/components/record-list'
import { carregarMe, serverApi } from '@/lib/api'
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
    carregarMe(),
  ])

  // A série de peso e o histórico de titularidade são do mesmo pet e da mesma tela;
  // buscá-los aqui evita que o cliente descubra depois que a aba estava vazia. Se
  // qualquer um falhar, o detalhe do pet ainda abre — nenhum dos dois é o assunto
  // principal da página.
  const [weights, transfers, album, safetyRecord, timeline] = await Promise.all([
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
    // MOD-PRONT-02. A primeira página vem com a tela; o resto entra por cursor,
    // sob demanda — carregar dois anos de histórico para uma aba que talvez
    // ninguém abra custaria o tempo de abertura de todas as outras.
    serverApi()
      .getPetTimeline(id, { limit: 20 })
      .catch(() => ({ entries: [], nextCursor: null })),
  ])

  const canUpdate = me.permissions.includes('pet:update')
  const primary = pet.tutors.find((tutor) => tutor.role === 'PRIMARY') ?? pet.tutors[0]

  return (
    <div className="space-y-6">
      <RecordHero
        back={{ href: '/pets', label: 'Pets' }}
        avatar={
          // Na ficha o avatar é maior: aqui ele não serve para varrer uma lista, e sim
          // para confirmar num relance que se abriu o pet certo.
          <PetAvatar
            coverPhotoUrl={pet.coverPhotoUrl}
            speciesKey={pet.species.key}
            petName={pet.name}
            size="lg"
          />
        }
        title={pet.name}
        badges={
          <>
            {pet.status === 'INACTIVE' && <Badge>Inativo</Badge>}
            {pet.status === 'DECEASED' && <Badge tone="danger">Falecido</Badge>}
            {pet.status === 'TRANSFERRED_OUT' && <Badge>Transferido</Badge>}
          </>
        }
        meta={[pet.species.label, pet.breed?.label, pet.size.label, primary?.fullName]
          .filter(Boolean)
          .join(' · ')}
        actions={
          // Falecido e transferido não se editam — é a mesma regra que a aba Dados seguia.
          canUpdate &&
          pet.status !== 'DECEASED' &&
          pet.status !== 'TRANSFERRED_OUT' && (
            <ButtonLink href={`/pets/${pet.id}/editar`}>Editar</ButtonLink>
          )
        }
        facts={[
          { label: 'Idade', value: pet.ageLabel ?? '—' },
          {
            label: 'Peso',
            value: pet.weightKg === null ? '—' : `${pet.weightKg.toLocaleString('pt-BR')} kg`,
          },
          {
            label: 'Último atendimento',
            value: pet.lastAttendanceAt ? formatDate(pet.lastAttendanceAt) : 'Nenhum',
          },
          {
            // O rótulo de cada alerta continua na faixa de aviso logo abaixo (RN-02);
            // aqui vai a contagem, para o número ter onde morar ao lado dos outros.
            label: 'Alertas',
            value: pet.alerts.length === 0 ? 'Nenhum' : pet.alerts.length,
            tone: topAlert(pet.alerts)?.critical ? 'danger' : undefined,
          },
        ]}
      />

      <PetDetailView
        pet={pet}
        weights={weights}
        transfers={transfers}
        album={album}
        safetyRecord={safetyRecord}
        timeline={timeline}
        canUpdate={canUpdate}
        canDelete={me.permissions.includes('pet:delete')}
        canWeigh={me.permissions.includes('pet:weigh')}
        canManageLifecycle={me.permissions.includes('pet:manage_lifecycle')}
        canUploadPhoto={me.permissions.includes('pet:upload_photo')}
        canWriteAlerts={me.permissions.includes('record:write_alerts')}
        canManageRecord={me.permissions.includes('record:write')}
        canWriteNotes={me.permissions.includes('record:write_notes')}
        canVoidAttendance={me.permissions.includes('record:void')}
      />
    </div>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}
