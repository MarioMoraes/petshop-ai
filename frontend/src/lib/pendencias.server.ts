import 'server-only'
import type { MeResponse, PermissionKey } from '@petshop/shared-types'
import { serverApi } from './api'
import { AGENT_SLA_MIN, JANELA_HORAS, type ContagemPendencias } from './pendencias'

/**
 * Consulta as sete fontes.
 *
 * Todo `catch` devolve `null`, nunca lança: o sino é enfeite da moldura, e um serviço
 * fora do ar não pode derrubar **toda** tela do Admin junto com ele. A tela de destino
 * é que dá a notícia ruim direito, com o texto e o botão de recarregar dela.
 */
export async function carregarPendencias(me: MeResponse): Promise<ContagemPendencias> {
  const pode = (chave: PermissionKey): boolean => me.permissions.includes(chave)

  const api = serverApi()
  const agora = new Date()
  const desde = new Date(agora.getTime() - JANELA_HORAS * 60 * 60 * 1000)

  const [atendimentos, aprovacoes, novosAgendamentos, exclusoes, leads, mensagens, inadimplentes] =
    await Promise.all([
      /*
       * `crm:read` — a mesma permissão da tela para onde a linha aponta. Quem lê o
       * histórico de mensagens é quem atende a fila.
       *
       * `limit: 1` porque só o `total` interessa, e ele vem de um `COUNT` no banco. O
       * recorte da espera é do servidor: contar na tela exigiria trazer a fila inteira
       * para descartar quase tudo.
       */
      pode('crm:read')
        ? api
            .listAgentConversations({
              status: 'HANDOFF',
              waitingOverMinutes: AGENT_SLA_MIN,
              limit: 1,
            })
            .then((r) => r.total)
            .catch(() => null)
        : Promise.resolve(null),

      /*
       * `schedule:read_all` e não `schedule:write_all`: quem só lê a agenda ainda
       * precisa saber que há pedido parado — é a recepção que vai chamar quem aprova.
       */
      pode('schedule:read_all')
        ? api.countPendingApprovals().catch(() => null)
        : Promise.resolve(null),

      /*
       * A mesma permissão dos pedidos, e é a resposta certa: as duas linhas levam para a
       * mesma visão da agenda, e avisar de um agendamento a quem não pode abri-lo seria
       * dar notícia sem endereço.
       *
       * `me.portalBookingsSeenAt` é a marca **desta pessoa neste estabelecimento** — vem
       * do vínculo, não do usuário. Quem atende dois petshops tem duas caixas de entrada,
       * e olhar a de um não pode apagar o aviso do outro.
       */
      pode('schedule:read_all')
        ? api
            .countNewPortalBookings({ since: me.portalBookingsSeenAt ?? undefined })
            .catch(() => null)
        : Promise.resolve(null),

      /*
       * `tutor:delete` e não `tutor:read`: a fila é uma lista de decisões sobre apagar
       * cadastro, e o gate do serviço é o mesmo da anonimização. Mostrá-la a quem não pode
       * decidir produziria uma pendência que a pessoa vê e não resolve.
       */
      pode('tutor:delete')
        ? api
            .countDeletionRequests()
            .then((r) => r.total)
            .catch(() => null)
        : Promise.resolve(null),

      pode('site:read_leads')
        ? api
            .countSiteLeads()
            .then((r) => r.newCount)
            .catch(() => null)
        : Promise.resolve(null),

      pode('crm:read')
        ? api
            .getMessageStats({ from: desde.toISOString(), to: agora.toISOString() })
            /*
             * Só `dead`, e **não** `failed + dead` como o painel de Mensagens soma em
             * "Falhas". As duas telas respondem perguntas diferentes: o painel conta
             * como foi o período, o sino conta o que precisa de gente agora.
             *
             * Uma tentativa que falha volta para `QUEUED` com backoff (`dispatch.ts`);
             * o motor tenta de novo sozinho, e chamar alguém para isso é alarme falso.
             * `DEAD` — "Desistimos" — é o estado em que ninguém mais tenta nada sem um
             * reenvio manual. É o único que é, de fato, pendência.
             */
            .then((s) => s.dead)
            .catch(() => null)
        : Promise.resolve(null),

      pode('tutor:read')
        ? api
            // `limit: 1` porque só o `total` interessa, e ele vem de um `COUNT` no banco
            // — não de somar a página. O mínimo do schema é 1, então uma linha vem junto.
            .listTutors({ tag: 'INADIMPLENTE', limit: 1, page: 1 })
            .then((r) => r.total)
            .catch(() => null)
        : Promise.resolve(null),
    ])

  return {
    atendimentos,
    aprovacoes,
    novosAgendamentos,
    exclusoes,
    leads,
    mensagens,
    inadimplentes,
  }
}
