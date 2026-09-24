import { PawPrintIcon, UsersIcon, WalletIcon } from '@/components/icons'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { ListSearch } from '@/components/list-search'
import {
  InitialsAvatar,
  Pagination,
  RecordCard,
  RecordFact,
  RecordGrid,
} from '@/components/record-list'
import { serverApi } from '@/lib/api'

/**
 * Listagem e busca de tutores (MOD-TUTOR-06).
 *
 * A forma é a de `components/record-list.tsx`, a mesma de `/pets`: rosto, nome e
 * contato na cabeça, etiquetas no corpo, os pets e o saldo no pé.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ q?: string; tag?: string; page?: string }>
}

export default async function TutoresPage({ searchParams }: PageProps) {
  const params = await searchParams
  const page = Number(params.page ?? '1')

  const [result, tags] = await Promise.all([
    serverApi().listTutors({ q: params.q, tag: params.tag, page, limit: 20 }),
    serverApi().listTags(),
  ])

  const isSearching = Boolean(params.q ?? params.tag)
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit))

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cadastros"
        title="Tutores"
        subtitle={subtitle(result.total, isSearching)}
        actions={<ButtonLink href="/tutores/novo">Novo tutor</ButtonLink>}
      />

      <ListSearch
        basePath="/tutores"
        placeholder="Buscar por nome, telefone ou CPF"
        ariaLabel="Buscar tutores"
        initialQuery={params.q ?? ''}
        filterParam="tag"
        filterLabel="Filtrar por etiqueta"
        filters={tags.map((tag) => ({ value: tag.key, label: tag.label, color: tag.color }))}
        activeFilter={params.tag ?? ''}
      />

      {result.data.length === 0 ? (
        isSearching ? (
          <EmptyState
            icon={<UsersIcon />}
            tone="icon-people"
            title="Nenhum tutor encontrado"
            description="Tente outro nome, telefone ou CPF. A busca também aceita o número com máscara."
          />
        ) : (
          <EmptyState
            icon={<UsersIcon />}
            tone="icon-people"
            title="Sua base começa aqui"
            description="O cadastro do tutor é o ponto de partida de tudo: pets, agenda e conta corrente."
            action={<ButtonLink href="/tutores/novo">Cadastrar o primeiro tutor</ButtonLink>}
          />
        )
      ) : (
        <RecordGrid>
          {result.data.map((tutor) => (
            <RecordCard
              key={tutor.id}
              href={`/tutores/${tutor.id}`}
              avatar={<InitialsAvatar name={tutor.displayName} tone="icon-people" />}
              title={tutor.displayName}
              meta={
                <span className="tabular-nums">
                  {[tutor.phoneMasked, tutor.cpfMasked].filter(Boolean).join(' · ')}
                </span>
              }
              badges={
                (tutor.status === 'INACTIVE' || tutor.dataCompleteness === 'PARTIAL') && (
                  <>
                    {tutor.status === 'INACTIVE' && <Badge>Inativo</Badge>}
                    {tutor.dataCompleteness === 'PARTIAL' && (
                      <Badge tone="accent">Cadastro incompleto</Badge>
                    )}
                  </>
                )
              }
              footer={
                <>
                  <RecordFact icon={<PawPrintIcon />} tone="icon-pet">
                    {tutor.petsCount === 0
                      ? 'Nenhum pet'
                      : tutor.petsCount === 1
                        ? '1 pet'
                        : `${tutor.petsCount} pets`}
                  </RecordFact>
                  {tutor.balance !== 0 && (
                    // Saldo só quando há: "R$ 0,00" em vinte cartões seria vinte vezes
                    // a mesma não-informação disputando o olho com a dívida de verdade.
                    <RecordFact icon={<WalletIcon />} tone="icon-money">
                      <span
                        className={`font-medium tabular-nums ${
                          tutor.balance < 0 ? 'text-danger' : 'text-success'
                        }`}
                      >
                        {formatCurrency(tutor.balance)}
                      </span>
                    </RecordFact>
                  )}
                </>
              }
            >
              {tutor.tags.length > 0 &&
                tutor.tags.map((tag) => (
                  <span
                    key={tag.key}
                    className="pill px-2.5 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
                  >
                    {tag.label}
                  </span>
                ))}
            </RecordCard>
          ))}
        </RecordGrid>
      )}

      <Pagination basePath="/tutores" params={params} page={page} totalPages={totalPages} />
    </div>
  )
}

function subtitle(total: number, isSearching: boolean): string {
  if (isSearching) return total === 1 ? '1 tutor encontrado' : `${total} tutores encontrados`
  return total === 1 ? '1 tutor cadastrado' : `${total} tutores cadastrados`
}

function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
