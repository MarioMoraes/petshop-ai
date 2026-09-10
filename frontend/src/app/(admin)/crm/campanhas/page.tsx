import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { CampaignsBoard } from './campaigns-board'

/**
 * Campanhas (MOD-CRM-07 e MOD-CRM-12).
 *
 * A tela existe para uma coisa: **fazer a pessoa olhar antes de disparar**. Por isso o
 * caminho não tem um botão "enviar" — tem um botão "ver quem recebe", e o disparo só
 * aparece depois da prévia, carregando o número que ela mostrou.
 *
 * A campanha de reativação aparece na mesma lista, mas ninguém a monta: ela nasce da
 * automação, e o que se lê dela aqui é o histórico de execuções. Escondê-la faria a
 * lista mentir sobre o que sai do estabelecimento.
 */

export const dynamic = 'force-dynamic'

export default async function CampanhasPage() {
  const [me, campaigns] = await Promise.all([
    carregarMe(),
    serverApi()
      .listCampaigns()
      .then((response) => response.data)
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
  ])

  const canSend = me.permissions.includes('crm:send')
  const failed = campaigns instanceof ApiError

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/crm" className="hover:underline">
            ← Mensagens
          </Link>
        }
        title="Campanhas"
        subtitle={
          failed
            ? 'O serviço não respondeu'
            : 'Um envio para muita gente de uma vez. Sempre com prévia antes.'
        }
      />

      {failed ? (
        <EmptyState
          title="O serviço não respondeu"
          description="O serviço de automações está indisponível agora. Recarregue em instantes."
        />
      ) : (
        <CampaignsBoard campaigns={campaigns} canSend={canSend} />
      )}
    </div>
  )
}
