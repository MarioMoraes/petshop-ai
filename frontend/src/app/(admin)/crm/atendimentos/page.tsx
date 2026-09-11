import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { AgentConversationStatusSchema, type AgentConversationStatus } from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { AgentCard } from './agent-card'
import { AtendimentosBoard } from './atendimentos-board'

/**
 * A fila de atendimento do WhatsApp (MOD-AI-06).
 *
 * A primeira tela do produto que mostra o que o **cliente** escreveu. Todas as outras
 * contam o que o petshop fez: o que foi agendado, o que foi cobrado, o que saiu para
 * quem. Aqui a linha nasce de alguém do outro lado mandando mensagem para o número do
 * estabelecimento — e enquanto o atendimento automático não existir, tudo o que chega
 * para aqui, que é o comportamento do AC-02 de MOD-AI-07 e não um estado provisório.
 *
 * O filtro vai na **URL**, como o do painel de entregas e a data da agenda: "a fila de
 * agora" é um link que a recepção manda para quem vai assumir.
 */

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AtendimentosPage({ searchParams }: PageProps) {
  const params = await searchParams
  const status = asStatus(params.status) ?? 'HANDOFF'

  const [me, conversas, config] = await Promise.all([
    carregarMe(),
    serverApi()
      .listAgentConversations({ status, limit: 30 })
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    // Falha aqui esconde o cartão em vez de derrubar a tela: a fila continua utilizável
    // sem a configuração, e é a fila que tem gente esperando do outro lado.
    serverApi()
      .getAgentSettings()
      .catch(() => null),
  ])

  const failed = conversas instanceof ApiError
  // `crm:manage` é o que a recepção tem, e é o que as três escritas exigem — ver o
  // comentário de `modules/agent/routes.ts` sobre a divergência do §5 do PRD.
  const podeAtender = me.permissions.includes('crm:manage')

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/crm" className="hover:underline">
            ← Mensagens
          </Link>
        }
        title="Atendimentos"
        subtitle={
          failed
            ? 'O serviço não respondeu'
            : 'O que os clientes mandaram pelo WhatsApp do estabelecimento.'
        }
      />

      {failed ? (
        <EmptyState
          title="O serviço não respondeu"
          description="O serviço de atendimentos está indisponível agora. Recarregue em instantes."
        />
      ) : (
        <>
          {config && (
            <AgentCard
              settings={config}
              podeConfigurar={me.permissions.includes('crm:configure')}
            />
          )}
          <AtendimentosBoard page={conversas} status={status} podeAtender={podeAtender} />
        </>
      )}
    </div>
  )
}

/** Filtro inválido é filtro nenhum: cai no padrão, que é a fila. */
function asStatus(value: string | string[] | undefined): AgentConversationStatus | undefined {
  return typeof value === 'string' &&
    (AgentConversationStatusSchema.options as readonly string[]).includes(value)
    ? (value as AgentConversationStatus)
    : undefined
}
