import type { Route } from 'next'

/**
 * O que precisa de alguém agora — a fonte do sino da topbar.
 *
 * **Não é uma caixa de notificações, e a diferença é deliberada.** Não há tabela de
 * avisos nem estado de lido: cada linha daqui é uma consulta ao trabalho que ainda
 * está pendente de verdade. Quem responde o contato do site vê o número cair sozinho;
 * ninguém precisa "marcar como lido", e nada fica pendurado depois de resolvido.
 *
 * O custo disso é que o sino só sabe do presente — não existe "você tem um contato
 * novo desde ontem". Em troca, ele nunca mente: não há como o contador discordar da
 * tela para onde ele aponta, que é o defeito clássico de um centro de notificações
 * com estado próprio.
 *
 * Este módulo é o **núcleo puro** — tipos e a montagem das linhas, sem rede. Quem
 * consulta os serviços é `pendencias.server.ts`; a separação existe para que a regra
 * que decide o que aparece possa ser testada sem subir nada, e para que o sino (que é
 * client) importe os tipos daqui sem arrastar `server-only` junto.
 */

export type PendenciaKey =
  | 'aprovacoes'
  | 'exclusoes'
  | 'leads'
  | 'mensagens'
  | 'inadimplentes'

export interface Pendencia {
  key: PendenciaKey
  count: number
  /** A linha em negrito: o número e o que ele conta. */
  titulo: string
  /** A linha de apoio: o recorte, para o número não ficar ambíguo. */
  detalhe: string
  /**
   * `Route` e não `string`: o projeto roda com `typedRoutes`, e um destino que não
   * existe mais vira erro de compilação em vez de um 404 que só o clique revela.
   */
  href: Route
}

/**
 * O que cada fonte devolveu. `null` é **"não apurado"** e não zero: ou a pessoa não
 * tem permissão para aquela tela, ou o serviço não respondeu. Somar as duas coisas
 * como zero faria o sino jurar que está tudo em ordem quando ele simplesmente não sabe.
 */
export interface ContagemPendencias {
  /**
   * A fila da triagem do Portal, com o dia do pedido mais próximo.
   *
   * É a única fonte que traz um destino junto do número, e o motivo é a tela: a visão
   * da agenda é por **dia**, então "3 pedidos" sem dizer qual dia abriria uma tela
   * vazia na metade das vezes.
   */
  aprovacoes: { count: number; nextDate: string | null } | null
  /**
   * Pedidos de exclusão de dados esperando decisão (MOD-PORTAL-09, AC-05).
   *
   * A fonte com o prazo mais duro das cinco, e a única com prazo **legal**: o art. 19 da
   * LGPD dá quinze dias para responder o titular. As outras esperam sem estragar; esta
   * vence.
   */
  exclusoes: number | null
  leads: number | null
  mensagens: number | null
  inadimplentes: number | null
}

/**
 * Janela das falhas de mensagem: 24 horas corridas, e não o dia do calendário.
 *
 * Exportada porque a linha do painel **anuncia** a janela ("nas últimas 24 horas") e
 * quem consulta o serviço a **aplica**. Se o número morasse nos dois lugares, o
 * primeiro ajuste deixaria o texto mentindo sobre o próprio dado.
 */
export const JANELA_HORAS = 24

function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`
}

/**
 * Das contagens para as linhas do painel — puro, para poder ser testado sem rede.
 *
 * Zero e `null` somem os dois, por motivos diferentes: zero não é pendência, e
 * `null` é coisa que não se sabe. Uma linha "0 contatos" só ocuparia espaço com a
 * ausência de trabalho.
 */
export function montarPendencias(contagem: ContagemPendencias): Pendencia[] {
  const linhas: Pendencia[] = []

  /**
   * Primeiro da lista, e não em ordem alfabética: é a única pendência com **prazo**.
   * O horário fica reservado por 24h e depois some sozinho, levando junto o cliente
   * que pediu. Contato do site e tutor inadimplente esperam sem estragar.
   */
  if (contagem.aprovacoes?.count) {
    const { count, nextDate } = contagem.aprovacoes
    linhas.push({
      key: 'aprovacoes',
      count,
      titulo: plural(count, 'horário pedido pelo site', 'horários pedidos pelo site'),
      detalhe: 'aguardando sua confirmação',
      href: nextDate ? `/agenda/dia?date=${nextDate}` : '/agenda/dia',
    })
  }

  /**
   * Logo depois das aprovações, e antes de tudo o mais.
   *
   * É a segunda pendência com prazo, e o dela é de lei — quinze dias contados do pedido.
   * Um contato do site esperando três dias é atendimento ruim; um pedido de exclusão
   * esperando dezesseis é infração.
   */
  if (contagem.exclusoes) {
    linhas.push({
      key: 'exclusoes',
      count: contagem.exclusoes,
      titulo: plural(
        contagem.exclusoes,
        'pedido de exclusão de dados',
        'pedidos de exclusão de dados',
      ),
      detalhe: 'aguardando resposta da equipe',
      href: '/configuracoes?aba=privacidade',
    })
  }

  if (contagem.leads) {
    linhas.push({
      key: 'leads',
      count: contagem.leads,
      titulo: plural(contagem.leads, 'contato do site', 'contatos do site'),
      detalhe: 'aguardando retorno',
      href: '/site/contatos?status=NEW',
    })
  }

  if (contagem.mensagens) {
    linhas.push({
      key: 'mensagens',
      count: contagem.mensagens,
      titulo: plural(contagem.mensagens, 'mensagem não saiu', 'mensagens não saíram'),
      detalhe: `desistimos nas últimas ${JANELA_HORAS}h`,
      href: '/crm?status=DEAD',
    })
  }

  if (contagem.inadimplentes) {
    linhas.push({
      key: 'inadimplentes',
      count: contagem.inadimplentes,
      titulo: plural(contagem.inadimplentes, 'tutor inadimplente', 'tutores inadimplentes'),
      detalhe: 'com pagamento em atraso',
      href: '/tutores?tag=INADIMPLENTE',
    })
  }

  return linhas
}
