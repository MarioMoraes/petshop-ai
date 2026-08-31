import { PageHeader } from '@/components/ui'
import { TutorForm } from '../tutor-form'

/** Cadastro de tutor (MOD-TUTOR-01). */

export const metadata = { title: 'Novo tutor — PetShop AI' }

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function NovoTutorPage({ searchParams }: PageProps) {
  // O cadastro que nasce de um contato do site chega pré-preenchido (AC-02 de
  // MOD-SITE-09). Nome e telefone são o que o formulário público coleta; o resto o
  // balcão completa com o cliente na frente.
  const params = await searchParams
  const prefill = {
    ...(firstOf(params.nome) ? { fullName: firstOf(params.nome) as string } : {}),
    ...(firstOf(params.telefone) ? { phone: firstOf(params.telefone) as string } : {}),
    ...(firstOf(params.lead) ? { leadId: firstOf(params.lead) as string } : {}),
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cadastros · Tutores"
        title="Novo tutor"
        subtitle="Nome e telefone bastam para começar. O resto pode vir depois."
      />
      <TutorForm prefill={Object.keys(prefill).length > 0 ? prefill : undefined} />
    </div>
  )
}
