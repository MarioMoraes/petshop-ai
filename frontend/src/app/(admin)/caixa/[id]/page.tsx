import { ApiError } from '@petshop/api-client'
import { notFound } from 'next/navigation'
import { AlertTriangleIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { EmptyState, PageHeader } from '@/components/ui'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { MethodCard, MovementsCard, SessionNumbers, formatDay } from '../session-view'

/**
 * Um fechamento de caixa, para conferir depois: a contagem congelada, a justificativa
 * da diferença e cada movimento daquele dia.
 */

export const dynamic = 'force-dynamic'

export default async function CaixaFechamentoPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await carregarMe()
  if (!temRecurso(me, 'CASH_REGISTER')) {
    return <PlanoIndisponivel me={me} feature="CASH_REGISTER" />
  }

  const { id } = await params
  const api = serverApi()
  const [session, settings] = await Promise.all([
    api.getCashSession(id).catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    }),
    api.getSettings().catch(() => null),
  ])
  const timeZone = settings?.timezone ?? 'America/Sao_Paulo'

  if (session instanceof ApiError) {
    if (session.status === 404 || session.status === 422) notFound()
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Caixa do dia" title="Fechamento" />
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="Não conseguimos carregar o fechamento"
          description={session.message}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Caixa do dia"
        title={session.status === 'OPEN' ? 'Caixa aberto' : 'Fechamento'}
        subtitle={formatDay(session.openedAt, timeZone)}
        actions={
          <>
            <ButtonLink href="/caixa">Voltar</ButtonLink>
            {/* Um `<a>` e não um botão: o PDF é um arquivo, e a rota do Next leva a
                sessão até o gateway e devolve os bytes. */}
            <a href={`/caixa/${session.id}/pdf`} download className="btn btn-primary">
              {session.status === 'OPEN' ? 'Conferência em PDF' : 'Fechamento em PDF'}
            </a>
          </>
        }
      />
      <SessionNumbers session={session} timeZone={timeZone} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <MethodCard session={session} />
        <MovementsCard movements={session.movements} timeZone={timeZone} />
      </div>
    </div>
  )
}
