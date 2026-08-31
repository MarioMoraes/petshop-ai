import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { FinanceiroTabs } from '../financeiro-tabs'
import { BillingSettingsForm } from './billing-settings-form'

/** Políticas financeiras do tenant (`billing_settings`). */

export const dynamic = 'force-dynamic'

export default async function FinanceiroConfiguracoesPage() {
  const api = serverApi()
  const [me, settings, receivables] = await Promise.all([
    api.me(),
    api.getBillingSettings(),
    // Só o gestor vê contas a receber; para quem só lê, o bloco não aparece.
    api.getReceivables().catch(() => null),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Financeiro"
        title="Políticas"
        subtitle="Limite de crédito, formas de pagamento aceitas e validade padrão dos pacotes."
      />

      <FinanceiroTabs />

      <BillingSettingsForm
        settings={settings}
        receivables={receivables}
        canEdit={me.permissions.includes('finance:configure')}
      />
    </div>
  )
}
