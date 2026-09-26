import type { MeResponse, PermissionKey } from '@petshop/shared-types'
import { carregarMe } from '@/lib/api'
import { FinanceiroTabsNav, type FinanceiroTab } from './financeiro-tabs-nav'

/**
 * As abas do Financeiro: Relatórios e Políticas.
 *
 * Cada aba aparece só para quem pode abri-la: Relatórios pede `cash:read` (os do
 * caixa) ou `finance:configure` (os de cobrança, que listam o telefone de quem deve).
 * Aba que levaria a uma recusa é pior que aba nenhuma.
 *
 * O Caixa não é aba daqui: é item próprio do menu lateral, porque é a tela que o balcão
 * mantém aberta o dia todo.
 */
export async function FinanceiroTabs() {
  return <FinanceiroTabsNav tabs={abasDoFinanceiro(await carregarMe())} />
}

export function abasDoFinanceiro(me: MeResponse): FinanceiroTab[] {
  const pode = (permission: PermissionKey) => me.permissions.includes(permission)
  const tabs: FinanceiroTab[] = []
  if (pode('cash:read') || pode('finance:configure')) {
    tabs.push({ href: '/financeiro/relatorios', label: 'Relatórios' })
  }
  if (pode('finance:read')) tabs.push({ href: '/financeiro/configuracoes', label: 'Políticas' })
  return tabs
}
