import { ApiError } from '@petshop/api-client'
import { AlertTriangleIcon, BanknoteIcon, ShieldCheckIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/ui'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { AdjustCashButton, CloseCashButton, OpenCashButton } from './cash-dialogs'
import {
  HistoryCard,
  MethodCard,
  MovementsCard,
  SessionNumbers,
  cashInDrawer,
  formatDay,
} from './session-view'

/**
 * O caixa do dia (MOD-CAIXA).
 *
 * Duas formas: **fechado**, a tela convida a abrir e mostra os fechamentos anteriores;
 * **aberto**, mostra o dinheiro da gaveta, o recebido por forma e cada movimento, com
 * sangria, suprimento e o fechamento no topo. A venda avulsa entra aqui sozinha, pelo
 * diálogo de venda do Estoque; o pagamento do tutor, pelo Financeiro.
 */

export const dynamic = 'force-dynamic'

export default async function CaixaPage() {
  // O plano antes de qualquer chamada: pedir a API primeiro traria o 402 para a tela.
  const me = await carregarMe()
  if (!temRecurso(me, 'CASH_REGISTER')) {
    return <PlanoIndisponivel me={me} feature="CASH_REGISTER" />
  }
  if (!me.permissions.includes('cash:read')) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Operação" title="Caixa do dia" />
        <EmptyState
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          title="O caixa é do balcão"
          description="Quem abre, recebe e fecha o caixa é a recepção e o administrador."
        />
      </div>
    )
  }

  const api = serverApi()
  const [current, history, settings] = await Promise.all([
    api.getCurrentCash().catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    }),
    api.listCashSessions({ limit: 10 }).catch(() => null),
    api.getSettings().catch(() => null),
  ])
  const timeZone = settings?.timezone ?? 'America/Sao_Paulo'
  const canOperate = me.permissions.includes('cash:operate')

  if (current instanceof ApiError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Operação" title="Caixa do dia" />
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="Não conseguimos carregar o caixa"
          description="O servidor não respondeu. Tente de novo em instantes."
        />
      </div>
    )
  }

  const session = current.session
  const past = (history?.items ?? []).filter((item) => item.id !== session?.id)

  if (!session) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Operação"
          title="Caixa do dia"
          subtitle="Nenhum caixa aberto"
          actions={canOperate ? <OpenCashButton /> : null}
        />
        <EmptyState
          icon={<BanknoteIcon />}
          tone="icon-money"
          title="O caixa está fechado"
          description="Abra o caixa com o troco da gaveta para vender sem tutor. Os pagamentos dos tutores registrados com o caixa aberto entram nele sozinhos."
        />
        <HistoryCard items={past} timeZone={timeZone} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operação"
        title="Caixa do dia"
        subtitle={`Aberto ${formatDay(session.openedAt, timeZone)}`}
        actions={
          canOperate ? (
            <>
              <AdjustCashButton cashInDrawerCents={cashInDrawer(session)} />
              <CloseCashButton sessionId={session.id} byMethod={session.byMethod} />
            </>
          ) : null
        }
      />
      <SessionNumbers session={session} timeZone={timeZone} />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <MethodCard session={session} />
        <MovementsCard movements={session.movements} timeZone={timeZone} />
      </div>
      <HistoryCard items={past} timeZone={timeZone} />
    </div>
  )
}
