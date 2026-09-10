import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { carregarMe, serverApi } from '@/lib/api'
import { CrmSettingsForm } from './settings-form'

/**
 * Configuração do relacionamento (MOD-CRM-03 e 04).
 *
 * A ordem da tela é a ordem das perguntas: **o motor está ligado?**, depois *o que ele
 * manda sozinho*, depois *quando e quanto pode mandar*, e por último *quem pediu para
 * não receber*. Começar pelas automações seria oferecer o ajuste fino de um motor que
 * pode estar desligado — e `enabled` nasce `false` de propósito, porque ligar é decisão
 * de quem responde pelo domínio de e-mail, não um padrão que o cliente descobre
 * recebendo mensagem.
 */

export const dynamic = 'force-dynamic'

export default async function CrmConfigPage() {
  const [me, settings, automations, suppressions, whatsapp] = await Promise.all([
    carregarMe(),
    serverApi()
      .getMessagingSettings()
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    serverApi()
      .listAutomations()
      .then((response) => response.data)
      .catch(() => []),
    // A lista de supressões exige `crm:configure`; para a recepção ela volta vazia, e
    // o bloco some. Falha aqui não derruba o resto da tela.
    serverApi()
      .listMessagingSuppressions()
      .then((response) => response.data)
      .catch(() => []),
    // Falha aqui esconde o cartão em vez de derrubar a tela: o resto da configuração
    // continua utilizável mesmo com a conexão de WhatsApp indisponível de consultar.
    serverApi()
      .getWhatsappConnection()
      .catch(() => null),
  ])

  const canConfigure = me.permissions.includes('crm:configure')
  const canConnectChannel = me.permissions.includes('crm:connect_channel')

  const header = (
    <PageHeader
      eyebrow={
        <Link href="/crm" className="hover:underline">
          ← Mensagens
        </Link>
      }
      title="Configuração"
      subtitle={
        settings instanceof ApiError
          ? 'O serviço não respondeu'
          : settings.enabled
            ? 'O envio automático está ligado'
            : 'O envio automático está desligado'
      }
      actions={
        <ButtonLink href="/crm/textos" variant="ghost">
          Textos
        </ButtonLink>
      }
    />
  )

  if (settings instanceof ApiError) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="O serviço não respondeu"
          description="O serviço de mensagens está indisponível agora. Recarregue em instantes."
        />
      </div>
    )
  }

  if (!canConfigure) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="Sem acesso à configuração"
          description="Janela de envio, automações e bloqueios são do administrador do estabelecimento. Os textos você pode consultar."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}
      <CrmSettingsForm
        settings={settings}
        automations={automations}
        suppressions={suppressions}
        whatsapp={whatsapp}
        canConnectChannel={canConnectChannel}
      />
    </div>
  )
}
