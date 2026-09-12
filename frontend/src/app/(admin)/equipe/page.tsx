import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { TeamManager } from './team-manager'

/**
 * Equipe (MOD-IDENT-04 e MOD-IDENT-06).
 *
 * Uma tela só para duas coisas que sempre foram a mesma pergunta — "quem trabalha
 * aqui?" —, e que o produto respondia pela metade: os vínculos existiam desde o
 * provisionamento, mas só o dono tinha um, porque não havia como convidar ninguém.
 *
 * Membros e convites aparecem juntos, e não em abas: um convite pendente é uma pessoa
 * que já foi contratada e ainda não entrou. Separá-los faria o admin ter de somar duas
 * listas para saber de quantos assentos do plano ele já dispôs.
 */

export const dynamic = 'force-dynamic'

export default async function EquipePage() {
  const me = await carregarMe()

  // O layout já barrou quem não terminou o onboarding. Esta linha é o que conta a
  // garantia ao compilador — `plan` sai de `currentTenant`, que sem ela é nulo no tipo.
  if (!me.currentTenant) redirect('/onboarding')

  // Sem poder listar, a tela não existe para este perfil — como em Configurações,
  // voltar ao início é mais honesto do que um 403 numa rota que o menu não ofereceu.
  if (!me.permissions.includes('team:read')) redirect('/dashboard')

  const canInvite = me.permissions.includes('team:invite')
  // Separada de `canInvite` porque a matriz as separa: `team:remove` é o que fecha a
  // porta de alguém, e um tenant pode conceder uma sem a outra (MOD-IDENT-04).
  const canRemove = me.permissions.includes('team:remove')

  const [members, invitations] = await Promise.all([
    serverApi().listTeam(),
    // Convite é assunto de quem convida. Para os demais, a lista de membros basta —
    // e pedir a rota sem a permissão só renderia um 403 no log de segurança.
    canInvite ? serverApi().listInvitations() : Promise.resolve([]),
  ])

  return (
    <>
      <PageHeader
        eyebrow="Estabelecimento"
        title="Equipe"
        subtitle="Quem tem acesso ao sistema, com que perfil, e os convites que ainda não foram aceitos."
      />

      <div className="mt-10">
        <TeamManager
          members={members}
          invitations={invitations}
          currentUserId={me.user.id}
          plan={me.currentTenant.plan}
          canInvite={canInvite}
          canRemove={canRemove}
        />
      </div>
    </>
  )
}
