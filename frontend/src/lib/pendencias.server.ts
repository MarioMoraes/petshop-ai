import 'server-only'
import type { MeResponse, PermissionKey } from '@petshop/shared-types'
import { serverApi } from './api'
import { JANELA_HORAS, type ContagemPendencias } from './pendencias'

/**
 * Consulta as três fontes.
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

  const [aprovacoes, leads, mensagens, inadimplentes] = await Promise.all([
    /*
     * `schedule:read_all` e não `schedule:write_all`: quem só lê a agenda ainda
     * precisa saber que há pedido parado — é a recepção que vai chamar quem aprova.
     */
    pode('schedule:read_all')
      ? api.countPendingApprovals().catch(() => null)
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

  return { aprovacoes, leads, mensagens, inadimplentes }
}
