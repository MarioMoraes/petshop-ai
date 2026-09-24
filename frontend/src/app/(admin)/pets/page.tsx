import { PetAvatar, SpeciesIcon } from '@/components/pet-avatar'
import { AlertTriangleIcon, PawPrintIcon, UsersIcon } from '@/components/icons'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { ListSearch } from '@/components/list-search'
import { Pagination, RecordCard, RecordFact, RecordGrid, topAlert } from '@/components/record-list'
import { serverApi } from '@/lib/api'

/**
 * Listagem e busca de pets (MOD-PET-01).
 *
 * A forma é a de `components/record-list.tsx`, a mesma de `/tutores`. Cada cartão traz
 * raça, porte e idade na meta e o responsável principal no pé: RN-16 diz que cinco
 * "Mel" no mesmo tenant é normal, e sem esses dados a lista seria indistinguível.
 *
 * O filtro por espécie fica sob a busca porque é o corte que mais rápido desfaz o
 * empate — separar cães de gatos.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ q?: string; speciesId?: string; page?: string }>
}

export default async function PetsPage({ searchParams }: PageProps) {
  const params = await searchParams
  const page = Number(params.page ?? '1')

  const [result, species] = await Promise.all([
    serverApi().listPets({
      q: params.q,
      speciesId: params.speciesId,
      page,
      limit: 20,
    }),
    serverApi().listSpecies(),
  ])

  const isSearching = Boolean(params.q ?? params.speciesId)
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit))

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cadastros"
        title="Pets"
        subtitle={subtitle(result.total, isSearching)}
        actions={<ButtonLink href="/pets/novo">Novo pet</ButtonLink>}
      />

      <ListSearch
        basePath="/pets"
        placeholder="Buscar por nome, raça, cor ou microchip"
        ariaLabel="Buscar pets"
        initialQuery={params.q ?? ''}
        filterParam="speciesId"
        filterLabel="Filtrar por espécie"
        filters={species.map((item) => ({
          value: item.id,
          label: item.label,
          icon: <SpeciesIcon speciesKey={item.key} />,
        }))}
        activeFilter={params.speciesId ?? ''}
      />

      {result.data.length === 0 ? (
        isSearching ? (
          <EmptyState
            icon={<PawPrintIcon />}
            tone="icon-pet"
            title="Nenhum pet encontrado"
            description="Tente outro nome, raça ou cor. A busca também aceita os 15 dígitos do microchip."
          />
        ) : (
          <EmptyState
            icon={<PawPrintIcon />}
            tone="icon-pet"
            title="Nenhum pet cadastrado ainda"
            description="Todo pet nasce vinculado a um responsável — cadastre o tutor primeiro, se ele ainda não existir."
            action={<ButtonLink href="/pets/novo">Cadastrar o primeiro pet</ButtonLink>}
          />
        )
      ) : (
        <RecordGrid>
          {result.data.map((pet) => {
            const primary = pet.tutors.find((tutor) => tutor.role === 'PRIMARY') ?? pet.tutors[0]
            const alert = topAlert(pet.alerts)

            return (
              <RecordCard
                key={pet.id}
                href={`/pets/${pet.id}`}
                avatar={
                  // RN-16: a foto desambigua mais rápido que raça ou tutor. Sem capa, o
                  // ícone da espécie — um espaço vazio faria a grade tremer.
                  <PetAvatar
                    coverPhotoUrl={pet.coverPhotoUrl}
                    speciesKey={pet.species.key}
                    petName={pet.name}
                    size="lg"
                  />
                }
                title={pet.name}
                meta={[pet.breed?.label ?? pet.species.label, pet.size.label, pet.ageLabel]
                  .filter(Boolean)
                  .join(' · ')}
                badges={
                  (pet.status !== 'ACTIVE' || alert) && (
                    <>
                      {pet.status === 'INACTIVE' && <Badge>Inativo</Badge>}
                      {pet.status === 'DECEASED' && <Badge tone="danger">Falecido</Badge>}
                      {pet.status === 'TRANSFERRED_OUT' && <Badge>Transferido</Badge>}
                      {alert && (
                        // O alerta mais grave do prontuário, antes de abrir a ficha: é o
                        // que o banhista precisa saber ao pegar o pet no colo.
                        <Badge tone={alert.critical ? 'danger' : 'accent'}>
                          <span className="mr-1 [&>svg]:h-3.5 [&>svg]:w-3.5">
                            <AlertTriangleIcon />
                          </span>
                          {alert.label}
                        </Badge>
                      )}
                    </>
                  )
                }
                footer={
                  primary ? (
                    <>
                      <RecordFact icon={<UsersIcon />} tone="icon-people">
                        <span className="font-medium text-ink">{primary.fullName}</span>
                      </RecordFact>
                      <span className="shrink-0 tabular-nums text-subtle">
                        {primary.phoneMasked}
                      </span>
                    </>
                  ) : (
                    // Acontece quando o único responsável foi anonimizado (LGPD): o pet
                    // sobrevive ao cadastro da pessoa, e precisa de um novo.
                    <RecordFact icon={<UsersIcon />} tone="icon-people">
                      <span className="text-accent-ink">Sem responsável</span>
                    </RecordFact>
                  )
                }
              />
            )
          })}
        </RecordGrid>
      )}

      <Pagination basePath="/pets" params={params} page={page} totalPages={totalPages} />
    </div>
  )
}

function subtitle(total: number, isSearching: boolean): string {
  if (isSearching) return total === 1 ? '1 pet encontrado' : `${total} pets encontrados`
  return total === 1 ? '1 pet cadastrado' : `${total} pets cadastrados`
}
