import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { Badge, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { TutorDetailView, type FinanceData } from './tutor-detail'

/** Visão 360º do tutor (MOD-TUTOR-07). */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function TutorPage({ params }: PageProps) {
  const { id } = await params

  const [me, overview, consents, tags, pets] = await Promise.all([
    serverApi().me(),
    serverApi()
      .getTutorOverview(id)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) notFound()
        throw error
      }),
    serverApi().getConsents(id),
    serverApi().listTags(),
    // Os pets vêm do pet-service, não da visão 360º: a composição é aqui, e não no
    // tutor-service lendo tabela de outro módulo.
    serverApi()
      .listPets({ tutorId: id, limit: 50 })
      .then((page) => page.data)
      .catch(() => []),
  ])

  const finance = await loadFinance(id, me.permissions)

  const tutor = overview.tutor

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tutores" className="hover:underline">
            ← Tutores
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {tutor.displayName}
            {tutor.status === 'INACTIVE' && <Badge>Inativo</Badge>}
            {tutor.status === 'ANONYMIZED' && <Badge tone="danger">Anonimizado</Badge>}
            {tutor.status === 'MERGED' && <Badge>Unificado a outro cadastro</Badge>}
            {tutor.dataCompleteness === 'PARTIAL' && (
              <Badge tone="accent">Cadastro incompleto</Badge>
            )}
          </span>
        }
        subtitle={`${tutor.phoneMasked}${tutor.email ? ` · ${tutor.email}` : ''}`}
      />

      <TutorDetailView
        overview={overview}
        consents={consents}
        tags={tags}
        pets={pets}
        finance={finance}
      />
    </div>
  )
}

/**
 * Carrega a conta corrente para quem pode vê-la (§9 do PRD financeiro).
 *
 * Devolve `null` sem `finance:read` — e aí a aba nem aparece. Renderizá-la para
 * depois mostrar um 403 seria pior que não oferecê-la: o banhista não tem por que
 * saber que a informação existe e lhe é negada.
 *
 * O catálogo de pacotes é opcional: um tenant que nunca criou pacote nenhum não
 * precisa ver o botão de vender, e o `catch` cobre o caso de a permissão de catálogo
 * ser mais restrita que a de leitura.
 */
async function loadFinance(
  tutorId: string,
  permissions: string[],
): Promise<FinanceData | null> {
  if (!permissions.includes('finance:read')) return null

  const api = serverApi()
  const [account, statement, packages, catalog] = await Promise.all([
    api.getLedgerAccount(tutorId),
    api.getStatement(tutorId, { limit: 20 }),
    api
      .listTutorPackages(tutorId)
      .then((result) => result.data)
      .catch(() => []),
    api
      .listServicePackages()
      .then((result) => result.data.filter((item) => item.active))
      .catch(() => []),
  ])

  return {
    account,
    statement,
    packages,
    catalog,
    can: {
      read: true,
      create: permissions.includes('finance:create'),
      refund: permissions.includes('finance:refund'),
      credit: permissions.includes('finance:credit'),
    },
  }
}
