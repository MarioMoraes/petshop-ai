import Link from 'next/link'
import { PetAvatar } from '@/components/pet-avatar'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { serverApi } from '@/lib/api'
import { PetSearch } from './pet-search'

/**
 * Listagem e busca de pets (MOD-PET-01).
 *
 * A busca vai na URL, e não no estado de um componente: o atendente pode mandar o
 * link, voltar pelo histórico e recarregar a página sem perder o que digitou.
 *
 * Cada linha traz raça, porte e o responsável principal. RN-16 diz que cinco "Mel" no
 * mesmo tenant é normal — sem esses três dados a lista seria indistinguível.
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
        subtitle={result.total === 1 ? '1 pet cadastrado' : `${result.total} pets cadastrados`}
        actions={<ButtonLink href="/pets/novo">Novo pet</ButtonLink>}
      />

      <PetSearch
        species={species}
        initialQuery={params.q ?? ''}
        activeSpeciesId={params.speciesId ?? ''}
      />

      {result.data.length === 0 ? (
        isSearching ? (
          <EmptyState
            title="Nenhum pet encontrado"
            description="Tente outro nome, raça ou cor. A busca também aceita os 15 dígitos do microchip."
          />
        ) : (
          <EmptyState
            title="Nenhum pet cadastrado ainda"
            description="Todo pet nasce vinculado a um responsável — cadastre o tutor primeiro, se ele ainda não existir."
            action={<ButtonLink href="/pets/novo">Cadastrar o primeiro pet</ButtonLink>}
          />
        )
      ) : (
        <ul className="space-y-2">
          {result.data.map((pet) => {
            const primary = pet.tutors.find((tutor) => tutor.role === 'PRIMARY') ?? pet.tutors[0]

            return (
              <li key={pet.id}>
                <Link
                  href={`/pets/${pet.id}`}
                  className="card flex flex-wrap items-center gap-4 px-5 py-4 transition-transform hover:-translate-y-0.5"
                >
                  {/*
                    RN-16: cinco "Mel" no mesmo tenant é normal, e a foto é o que
                    desambigua mais rápido que raça ou tutor. Sem capa, o ícone da
                    espécie — um espaço vazio faria a lista tremer conforme os pets
                    tivessem foto ou não.
                  */}
                  <PetAvatar
                    coverPhotoUrl={pet.coverPhotoUrl}
                    speciesKey={pet.species.key}
                    petName={pet.name}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{pet.name}</span>
                      {pet.status === 'INACTIVE' && <Badge>Inativo</Badge>}
                      {pet.status === 'DECEASED' && <Badge tone="danger">Falecido</Badge>}
                      {pet.status === 'TRANSFERRED_OUT' && <Badge>Transferido</Badge>}
                    </div>
                    <p className="hint mt-1">
                      {[pet.species.label, pet.breed?.label, pet.size.label, pet.ageLabel]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>

                  <div className="text-right">
                    {primary ? (
                      <>
                        <p className="text-sm font-medium">{primary.fullName}</p>
                        <p className="hint">{primary.phoneMasked}</p>
                      </>
                    ) : (
                      // Acontece quando o único responsável foi anonimizado (LGPD):
                      // o pet sobrevive ao cadastro da pessoa, e precisa de um novo.
                      <p className="hint text-accent-ink">Sem responsável</p>
                    )}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-3" aria-label="Paginação">
          <PageLink params={params} page={page - 1} disabled={page <= 1}>
            Anterior
          </PageLink>
          <span className="hint">
            Página {page} de {totalPages}
          </span>
          <PageLink params={params} page={page + 1} disabled={page >= totalPages}>
            Próxima
          </PageLink>
        </nav>
      )}
    </div>
  )
}

function PageLink({
  params,
  page,
  disabled,
  children,
}: {
  params: { q?: string; speciesId?: string }
  page: number
  disabled: boolean
  children: React.ReactNode
}) {
  if (disabled) {
    return <span className="btn btn-ghost opacity-40">{children}</span>
  }
  const search = new URLSearchParams()
  if (params.q) search.set('q', params.q)
  if (params.speciesId) search.set('speciesId', params.speciesId)
  search.set('page', String(page))

  return (
    <ButtonLink href={`/pets?${search.toString()}`} variant="ghost">
      {children}
    </ButtonLink>
  )
}
