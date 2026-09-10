import Link from 'next/link'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { serverApi } from '@/lib/api'
import { TutorSearch } from './tutor-search'

/**
 * Listagem e busca de tutores (MOD-TUTOR-06).
 *
 * A busca vai na URL, e não no estado de um componente: o atendente pode mandar o
 * link, voltar pelo histórico e recarregar a página sem perder o que digitou.
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
        subtitle={result.total === 1 ? '1 tutor cadastrado' : `${result.total} tutores cadastrados`}
        actions={<ButtonLink href="/tutores/novo">Novo tutor</ButtonLink>}
      />

      <TutorSearch tags={tags} initialQuery={params.q ?? ''} activeTag={params.tag ?? ''} />

      {result.data.length === 0 ? (
        isSearching ? (
          <EmptyState
            title="Nenhum tutor encontrado"
            description="Tente outro nome, telefone ou CPF. A busca também aceita o número com máscara."
          />
        ) : (
          <EmptyState
            title="Sua base começa aqui"
            description="O cadastro do tutor é o ponto de partida de tudo: pets, agenda e conta corrente."
            action={<ButtonLink href="/tutores/novo">Cadastrar o primeiro tutor</ButtonLink>}
          />
        )
      ) : (
        <ul className="space-y-2">
          {result.data.map((tutor) => (
            <li key={tutor.id}>
              <Link
                href={`/tutores/${tutor.id}`}
                className="card flex flex-wrap items-center gap-4 px-5 py-4 transition-transform hover:-translate-y-0.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{tutor.displayName}</span>
                    {tutor.status === 'INACTIVE' && <Badge>Inativo</Badge>}
                    {tutor.dataCompleteness === 'PARTIAL' && (
                      <Badge tone="accent">Cadastro incompleto</Badge>
                    )}
                    {tutor.tags.map((tag) => (
                      <span
                        key={tag.key}
                        className="pill px-2.5 py-0.5 text-xs font-medium"
                        style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
                      >
                        {tag.label}
                      </span>
                    ))}
                  </div>
                  <p className="hint mt-1">
                    {tutor.phoneMasked}
                    {tutor.cpfMasked ? ` · ${tutor.cpfMasked}` : ''}
                  </p>
                </div>

                <div className="text-right">
                  {tutor.balance !== 0 && (
                    <p
                      className={`text-sm font-medium ${
                        tutor.balance < 0 ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {formatCurrency(tutor.balance)}
                    </p>
                  )}
                  <p className="hint">
                    {tutor.petsCount === 1 ? '1 pet' : `${tutor.petsCount} pets`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
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
  params: { q?: string; tag?: string }
  page: number
  disabled: boolean
  children: React.ReactNode
}) {
  if (disabled) {
    return <span className="btn btn-ghost opacity-40">{children}</span>
  }
  const search = new URLSearchParams()
  if (params.q) search.set('q', params.q)
  if (params.tag) search.set('tag', params.tag)
  search.set('page', String(page))

  return (
    <ButtonLink href={`/tutores?${search.toString()}`} variant="ghost">
      {children}
    </ButtonLink>
  )
}

function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
