import { PageHeader } from '@/components/ui'
import { TutorForm } from '../tutor-form'

/** Cadastro de tutor (MOD-TUTOR-01). */

export const metadata = { title: 'Novo tutor — PetShop AI' }

export default function NovoTutorPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Cadastros · Tutores"
        title="Novo tutor"
        subtitle="Nome e telefone bastam para começar. O resto pode vir depois."
      />
      <TutorForm />
    </div>
  )
}
