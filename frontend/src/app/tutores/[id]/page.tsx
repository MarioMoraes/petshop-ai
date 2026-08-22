import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { Badge, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { TutorDetailView } from './tutor-detail'

/** Visão 360º do tutor (MOD-TUTOR-07). */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function TutorPage({ params }: PageProps) {
  const { id } = await params

  const [overview, consents, tags] = await Promise.all([
    serverApi()
      .getTutorOverview(id)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) notFound()
        throw error
      }),
    serverApi().getConsents(id),
    serverApi().listTags(),
  ])

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

      <TutorDetailView overview={overview} consents={consents} tags={tags} />
    </div>
  )
}
