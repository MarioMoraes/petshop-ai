import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PLAN_CATALOG, minimumPlanFor } from '@petshop/shared-types'
import { SparkleIcon } from '@/components/icons'
import { Alert, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { planoDe, temRecurso } from '@/components/plano-indisponivel'
import { AiKeyCard } from './ai-key-card'
import { AsaasCard } from './asaas-card'
import { EmailCard } from './email-card'
import { EmailDomainCard } from './email-domain-card'
import { PixCard } from './pix-card'
import { WhatsappCard } from './whatsapp-card'

/**
 * Integrações — o que o petshop conecta para o sistema falar com o mundo.
 *
 * Um lugar só para o que antes estava espalhado: o WhatsApp e o remetente do e-mail
 * moravam nas configurações do relacionamento, a chave PIX nas políticas do financeiro.
 * Nenhuma rota mudou; cada seção grava pelo endpoint de sempre, com o corte de permissão
 * de sempre.
 *
 * Cada seção aparece para quem pode **ler** o dado dela, e grava só para quem pode
 * configurá-lo — a recepção vê o estado do WhatsApp (AC-06 de MOD-CRM-01) sem poder
 * trocar o número. Leitura que falha esconde a seção, e não derruba a tela: a conexão
 * do WhatsApp fora do ar não pode impedir de salvar a chave PIX.
 */

export const dynamic = 'force-dynamic'

export default async function IntegracoesPage() {
  const me = await carregarMe()
  const pode = (permission: (typeof me.permissions)[number]) => me.permissions.includes(permission)

  const leMensagens = pode('crm:read')
  const leFinanceiro = pode('finance:read')
  if (!leMensagens && !leFinanceiro) redirect('/configuracoes')

  const temWhatsapp = temRecurso(me, 'WHATSAPP')
  const temAgente = temRecurso(me, 'AI_AGENT')
  const api = serverApi()

  const [messaging, emailDomain, whatsapp, billing, agent, online] = await Promise.all([
    leMensagens ? api.getMessagingSettings().catch(() => null) : null,
    leMensagens ? api.getEmailDomain().catch(() => null) : null,
    leMensagens && temWhatsapp ? api.getWhatsappConnection().catch(() => null) : null,
    leFinanceiro ? api.getBillingSettings().catch(() => null) : null,
    leMensagens && temAgente ? api.getAgentSettings().catch(() => null) : null,
    leFinanceiro ? api.getOnlineBilling().catch(() => null) : null,
  ])

  const plano = planoDe(me)

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/configuracoes" className="hover:underline">
            ← Configurações
          </Link>
        }
        title="Integrações"
        subtitle="Os serviços que o petshop conecta: o WhatsApp da empresa, o e-mail que chega ao tutor, como ele paga e a conta da IA que atende no WhatsApp."
      />

      <div className="mt-10 space-y-6">
        {leMensagens &&
          (temWhatsapp ? (
            whatsapp && <WhatsappCard initial={whatsapp} canConnect={pode('crm:connect_channel')} />
          ) : (
            <Alert
              tone="accent"
              role="status"
              icon={<SparkleIcon />}
              title={`WhatsApp está no plano ${PLAN_CATALOG[minimumPlanFor('WHATSAPP')].name}`}
            >
              No plano {PLAN_CATALOG[plano].name}, as mensagens automáticas saem por e-mail.
            </Alert>
          ))}

        {messaging && <EmailCard settings={messaging} canEdit={pode('crm:configure')} />}

        {emailDomain && <EmailDomainCard data={emailDomain} canEdit={pode('tenant:configure')} />}

        {online && <AsaasCard connection={online.connection} canEdit={pode('tenant:configure')} />}

        {billing && <PixCard settings={billing} canEdit={pode('finance:configure')} />}

        {agent && <AiKeyCard settings={agent} canEdit={pode('tenant:configure')} />}
      </div>
    </>
  )
}
