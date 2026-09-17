import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { SiteLeadStatusSchema, type SiteLeadStatus } from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { LeadQueue } from './lead-queue'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'

/**
 * A fila de contatos do site (MOD-SITE-09).
 *
 * O filtro vai na **URL**, como no painel de mensagens: "os contatos novos" é uma
 * pergunta, e pergunta que não cabe num link não se passa adiante.
 *
 * A tela abre para quem tem `site:read_leads` — a recepção inclusive. Converter em
 * cliente exige, além disso, `tutor:create`: ver o contato e criar a ficha são coisas
 * diferentes na matriz, e o módulo não a contorna.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function statusOf(value: unknown): SiteLeadStatus | undefined {
  const parsed = SiteLeadStatusSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export default async function SiteLeadsPage({ searchParams }: PageProps) {
  // O plano antes de qualquer chamada: a página renderiza em paralelo com o layout, e
  // pedir a API primeiro traria o 402 para dentro da tela (ver `plano-indisponivel.tsx`).
  const sessao = await carregarMe()
  if (!temRecurso(sessao, 'SITE')) return <PlanoIndisponivel me={sessao} feature="SITE" />

  const params = await searchParams
  const status = statusOf(params.status)

  const me = await carregarMe()

  const leads = await serverApi()
    .listSiteLeads(status)
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/site" className="hover:underline">
            ← Site
          </Link>
        }
        title="Contatos do site"
        subtitle={
          leads instanceof ApiError
            ? 'O serviço não respondeu'
            : leads.newCount > 0
              ? `${leads.newCount} aguardando retorno`
              : 'Nenhum contato aguardando'
        }
      />

      {leads instanceof ApiError ? (
        <EmptyState title="Não foi possível carregar os contatos" description={leads.message} />
      ) : (
        <LeadQueue
          leads={leads.items}
          status={status}
          canConvert={me.permissions.includes('tutor:create')}
        />
      )}
    </>
  )
}
