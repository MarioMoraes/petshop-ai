import {
  PLATFORM_PLANS,
  PLATFORM_TENANT_STATUSES,
  type TenantListQuery,
} from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { serverApi } from '@/lib/api'
import { ler } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from '../frame'
import { Filtros } from './filtros'
import { Estabelecimentos } from './lista'

/**
 * O painel de estabelecimentos (MOD-ADMIN-03 e 07).
 *
 * É a primeira das três perguntas que a operação comercial faz toda semana — *quantos
 * tenants estão ativos e em que plano* —, e até aqui a resposta saía do `psql`.
 *
 * **A ordem da lista é do backend, e não é alfabética**: quem falhou no provisionamento
 * vem primeiro, porque é o único estado em que o produto precisa de intervenção humana da
 * plataforma para destravar. Ordenar por nome esconderia justamente a linha que pede
 * socorro.
 */

export const dynamic = 'force-dynamic'

/** O mesmo teto do schema da rota. Vinte cabem na tela sem virar rolagem infinita. */
const POR_PAGINA = 20

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function EstabelecimentosPage({ searchParams }: PageProps) {
  const params = await searchParams
  const status = umDe(params.status, PLATFORM_TENANT_STATUSES)
  const plan = umDe(params.plan, PLATFORM_PLANS)
  const q = texto(params.q)
  const page = pagina(params.page)

  const query: Partial<TenantListQuery> = {
    page,
    limit: POR_PAGINA,
    ...(status ? { status } : {}),
    ...(plan ? { plan } : {}),
    ...(q ? { q } : {}),
  }

  const leitura = await ler(serverApi().listPlatformTenants(query))
  if (leitura.estado === 'fechado') return <SemAcesso />

  const total = leitura.estado === 'ok' ? leitura.dado.total : 0
  const ultimaPagina = Math.max(1, Math.ceil(total / POR_PAGINA))

  return (
    <PlataformaShell active="estabelecimentos">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          eyebrow="Plataforma"
          title="Estabelecimentos"
          subtitle={
            leitura.estado === 'ok'
              ? `${total} ${total === 1 ? 'estabelecimento' : 'estabelecimentos'} no filtro atual`
              : 'A plataforma não respondeu'
          }
        />

        <Filtros status={status ?? ''} plan={plan ?? ''} q={q ?? ''} />

        {leitura.estado === 'erro' ? (
          <Falha titulo="A lista não veio" mensagem={leitura.mensagem} />
        ) : leitura.dado.data.length === 0 ? (
          <EmptyState
            title="Nenhum estabelecimento neste recorte"
            description={
              status || plan || q
                ? 'Nada corresponde ao filtro. Amplie a busca ou limpe os campos.'
                : 'Ainda não há estabelecimento nenhum na instalação.'
            }
          />
        ) : (
          <>
            <Estabelecimentos itens={leitura.dado.data} />
            <Paginacao page={page} ultima={ultimaPagina} query={query} />
          </>
        )}
      </div>
    </PlataformaShell>
  )
}

/**
 * Anterior e próxima, e não a régua numerada.
 *
 * A lista é ordenada por urgência, não por nome: pular para a página 7 não leva a lugar
 * nenhum que se possa nomear, e a régua sugeriria que leva.
 */
function Paginacao({
  page,
  ultima,
  query,
}: {
  page: number
  ultima: number
  query: Partial<TenantListQuery>
}) {
  if (ultima <= 1) return null

  return (
    <nav className="flex items-center justify-between gap-4" aria-label="Paginação">
      {page > 1 ? (
        <ButtonLink href={`/plataforma/estabelecimentos?${busca(query, page - 1)}`} variant="ghost">
          Anterior
        </ButtonLink>
      ) : (
        <span />
      )}

      <p className="hint tabular-nums">
        Página {page} de {ultima}
      </p>

      {page < ultima ? (
        <ButtonLink href={`/plataforma/estabelecimentos?${busca(query, page + 1)}`} variant="ghost">
          Próxima
        </ButtonLink>
      ) : (
        <span />
      )}
    </nav>
  )
}

/** A query da página vizinha, com o filtro corrente preservado. */
function busca(query: Partial<TenantListQuery>, destino: number): string {
  const search = new URLSearchParams()
  if (query.status) search.set('status', query.status)
  if (query.plan) search.set('plan', query.plan)
  if (query.q) search.set('q', query.q)
  if (destino > 1) search.set('page', String(destino))
  return search.toString()
}

function umDe<T extends string>(valor: unknown, aceitos: readonly T[]): T | undefined {
  return typeof valor === 'string' && (aceitos as readonly string[]).includes(valor)
    ? (valor as T)
    : undefined
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim().slice(0, 80) : undefined
}

function pagina(valor: unknown): number {
  const numero = typeof valor === 'string' ? Number.parseInt(valor, 10) : Number.NaN
  return Number.isFinite(numero) && numero > 0 ? numero : 1
}
