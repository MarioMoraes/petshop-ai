import { notFound } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { TutorForm } from '../../tutor-form'

/** Edição de tutor (MOD-TUTOR-01). */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditarTutorPage({ params }: PageProps) {
  const { id } = await params

  const tutor = await serverApi()
    .getTutor(id)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) notFound()
      throw error
    })

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Cadastros · Tutores" title={`Editar ${tutor.displayName}`} />
      <TutorForm tutor={tutor} />
    </div>
  )
}
