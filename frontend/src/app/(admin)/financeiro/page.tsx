import { redirect } from 'next/navigation'
import { carregarMe } from '@/lib/api'

/**
 * `/financeiro` não é tela: é o atalho para a primeira aba que serve a quem chegou —
 * os Relatórios, e as Políticas para quem não tem relatório nenhum a abrir.
 */
export default async function FinanceiroIndex() {
  const me = await carregarMe()
  if (me.permissions.includes('cash:read') || me.permissions.includes('finance:configure')) {
    redirect('/financeiro/relatorios')
  }
  redirect('/financeiro/configuracoes')
}
