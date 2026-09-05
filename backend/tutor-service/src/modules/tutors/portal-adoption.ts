import { withTenant } from '@petshop/db'
import type { PortalAdoption } from '@petshop/shared-types'

/**
 * Adoção do Portal pela carteira — a faixa do Portal no painel do Início.
 *
 * **Por que aqui.** `getTutorOverview` recusa compor agenda e financeiro neste serviço,
 * e a regra é boa: o tutor-service não lê a tabela de outro módulo. Este caso é o
 * contorno consciente dela, por duas razões. A linha de `portal_link_challenges` é o
 * registro de um tutor tentando ligar **a própria ficha** a um login, e aponta para
 * `tutors` por chave estrangeira — é cadastro, não é agenda. E o serviço que escreve
 * essa linha, o `portal-bff`, não pode servi-la: o gateway mantém `/portal/v1` com
 * allowlist e sessão próprias justamente para que nenhum papel administrativo entre por
 * lá (AC-04 de MOD-PORTAL-11). Deixar o número onde ele nasce significaria não ter o
 * número.
 *
 * O KPI do PRD-mãe — a fatia de agendamentos vinda do Portal — **não está aqui**: esse
 * é `appointments`, tabela do scheduling-service, e ali a regra vale inteira. A tela
 * compõe os dois, como já faz com o resto do painel.
 */
export async function portalAdoption(
  tenantId: string,
  days: number,
  now: Date = new Date(),
): Promise<PortalAdoption> {
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  return withTenant(tenantId, async (tx) => {
    const [requested, completed, active, total] = await Promise.all([
      /*
       * Um pedido é uma linha, e não um identificador distinto: quem pede o código
       * três vezes porque o WhatsApp demorou tentou três vezes, e o funil existe
       * justamente para mostrar esse atrito. Contar identificadores únicos faria a
       * insistência desaparecer, que é o oposto do que a métrica serve para ver.
       */
      tx.portalLinkChallenge.count({ where: { createdAt: { gte: from, lt: to } } }),
      tx.portalLinkChallenge.count({
        where: { createdAt: { gte: from, lt: to }, consumedAt: { not: null } },
      }),
      // `portalLastSeenAt` é escrito a cada visita ao Portal, não só no login: quem
      // entrou uma vez em janeiro e nunca voltou não é usuário ativo em março.
      tx.tutor.count({
        where: { status: 'ACTIVE', portalLastSeenAt: { gte: from } },
      }),
      tx.tutor.count({ where: { status: 'ACTIVE' } }),
    ])

    return {
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      linking: { requested, completed },
      tutors: { active, total },
    }
  })
}
