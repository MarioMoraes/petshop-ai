import 'server-only'
import type { MeResponse } from '@petshop/shared-types'
import { serverApi } from './api'
import type { ContagemPendencias } from './pendencias'

const NADA: ContagemPendencias = {
  atendimentos: null,
  aprovacoes: null,
  novosAgendamentos: null,
  exclusoes: null,
  leads: null,
  mensagens: null,
  inadimplentes: null,
  estoque: null,
  caixa: null,
}

/**
 * As nove fontes do sino, numa chamada só (`GET /v1/me/pending`).
 *
 * Eram nove chamadas daqui, uma por fonte, a cada navegação — e a moldura esperava todas
 * antes de a página aparecer. Quem decide quais fontes cabem a esta pessoa (permissão e
 * plano) agora é o backend, com as mesmas regras que moravam aqui; ver
 * `backend/app/src/gateway/pending.ts`.
 *
 * O `catch` devolve tudo `null`, nunca lança: o sino é enfeite da moldura, e um serviço
 * fora do ar não pode derrubar **toda** tela do Admin junto com ele. A tela de destino
 * é que dá a notícia ruim direito, com o texto e o botão de recarregar dela.
 *
 * `me.portalBookingsSeenAt` é a marca **desta pessoa neste estabelecimento** — vem do
 * vínculo, não do usuário. Quem atende dois petshops tem duas caixas de entrada.
 */
export async function carregarPendencias(me: MeResponse): Promise<ContagemPendencias> {
  const contagens = await serverApi()
    .getPendingCounts(me.portalBookingsSeenAt ? { since: me.portalBookingsSeenAt } : {})
    .catch(() => null)
  if (!contagens) return NADA

  return {
    atendimentos: contagens.agentHandoffs,
    aprovacoes: contagens.pendingApprovals,
    novosAgendamentos: contagens.newPortalBookings,
    exclusoes: contagens.deletionRequests,
    leads: contagens.siteLeads,
    mensagens: contagens.deadMessages,
    inadimplentes: contagens.overdueTutors,
    estoque: contagens.inventory,
    caixa: contagens.cash,
  }
}
