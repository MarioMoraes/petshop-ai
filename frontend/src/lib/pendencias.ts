import { AGENT_SLA_MIN, type InventoryAlerts } from '@petshop/shared-types'
import type { Route } from 'next'

/**
 * O que precisa de alguém agora — a fonte do sino da topbar.
 *
 * **Quase nada aqui é notificação, e a diferença é deliberada.** Não há tabela de
 * avisos: cada linha é uma consulta ao trabalho que ainda está pendente de verdade.
 * Quem responde o contato do site vê o número cair sozinho; ninguém precisa "marcar
 * como lido", e nada fica pendurado depois de resolvido. O contador não tem como
 * discordar da tela para onde ele aponta, que é o defeito clássico de um centro de
 * notificações com estado próprio.
 *
 * **A exceção é `novosAgendamentos`, e ela prova a regra.** O agendamento que o tutor
 * marcou no Portal já está confirmado e já está na agenda: não há trabalho a fazer,
 * então não há nada que faça o número cair. Ou ele ganha marca de lido
 * (`memberships.portal_bookings_seen_at`), ou fica aceso para sempre. É a única linha
 * que abrir o sino apaga — ver `CHAVES_COM_LEITURA`.
 *
 * Este módulo é o **núcleo puro** — tipos e a montagem das linhas, sem rede. Quem
 * consulta os serviços é `pendencias.server.ts`; a separação existe para que a regra
 * que decide o que aparece possa ser testada sem subir nada, e para que o sino (que é
 * client) importe os tipos daqui sem arrastar `server-only` junto.
 */

export type PendenciaKey =
  | 'atendimentos'
  | 'aprovacoes'
  | 'novosAgendamentos'
  | 'exclusoes'
  | 'leads'
  | 'mensagens'
  | 'inadimplentes'
  | 'lotesVencendo'
  | 'saldoNegativo'
  | 'produtosRepor'

/**
 * As linhas que **não** são trabalho parado, e por isso precisam de marca de lido.
 *
 * Hoje é uma só. O agendamento que o tutor marcou no Portal já está confirmado e já
 * está na agenda: não há o que fazer com ele, então o contador não teria como cair
 * sozinho. Abrir o sino é o que o apaga — e é a única linha de que isso vale.
 *
 * Lista, e não um campo em `Pendencia`, porque quem precisa dela é o sino (client) para
 * decidir o que marcar ao abrir, e uma flag por linha convidaria a resposta errada:
 * marcar tudo como visto apagaria pendência de verdade.
 */
export const CHAVES_COM_LEITURA: readonly PendenciaKey[] = ['novosAgendamentos']

/**
 * O número do ponto vermelho: tudo o que ainda não foi visto.
 *
 * Função pura, e no `lib/` e não dentro do sino, por um motivo prático: o painel abre
 * por clique, e comportamento que depende de JavaScript não se verifica pela receita de
 * captura do projeto. Aqui ele é um teste.
 *
 * **Desconta a linha inteira, e não uma parte dela.** Não há contagem parcial de
 * novidade: ou a pessoa abriu o painel e viu tudo o que estava lá, ou não abriu.
 */
export function contarNaoVistos(pendencias: Pendencia[], vistos: readonly PendenciaKey[]): number {
  return pendencias.reduce((soma, p) => (vistos.includes(p.key) ? soma : soma + p.count), 0)
}

/**
 * O que esta abertura do painel deve marcar como visto.
 *
 * Só as linhas de `CHAVES_COM_LEITURA`, e só as que ainda não foram marcadas. As duas
 * condições importam: a primeira impede que abrir o sino apague pendência de verdade, e
 * a segunda evita uma ida ao servidor por abertura de painel já lido.
 */
export function chavesAMarcar(
  pendencias: Pendencia[],
  vistos: readonly PendenciaKey[],
): PendenciaKey[] {
  return pendencias
    .filter((p) => CHAVES_COM_LEITURA.includes(p.key) && !vistos.includes(p.key))
    .map((p) => p.key)
}

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
   * Conversas de WhatsApp esperando a recepção há mais de `AGENT_SLA_MIN` (MOD-AI-06,
   * AC-04).
   *
   * A fonte mais imediata das sete, e a única em que **alguém está esperando agora**: um
   * cliente mandou mensagem para o número do petshop e ninguém respondeu. As outras
   * contam trabalho parado; esta conta uma pessoa parada.
   */
  atendimentos: number | null
  /**
   * A fila da triagem do Portal, com o dia do pedido mais próximo.
   *
   * Traz um destino junto do número, e o motivo é a tela: a visão da agenda é por
   * **dia**, então "3 pedidos" sem dizer qual dia abriria uma tela vazia na metade das
   * vezes. `novosAgendamentos` carrega o mesmo par, pela mesma razão.
   */
  aprovacoes: { count: number; nextDate: string | null } | null
  /**
   * Agendamentos que o tutor marcou no Portal desde a última vez que **esta pessoa**
   * abriu o sino (MOD-PORTAL-05).
   *
   * A única fonte com estado de lido, e a única que não é pendência: o agendamento já
   * está confirmado e já está na agenda. Sem a marca, o contador ficaria aceso para
   * sempre — com ela, ele é aviso de novidade e some quando alguém olha.
   *
   * Traz `nextDate` pela mesma razão que `aprovacoes`: a visão da agenda é por dia.
   */
  novosAgendamentos: { count: number; nextDate: string | null } | null
  /**
   * Pedidos de exclusão de dados esperando decisão (MOD-PORTAL-09, AC-05).
   *
   * A fonte com o prazo mais duro de todas, e a única com prazo **legal**: o art. 19 da
   * LGPD dá quinze dias para responder o titular. As outras esperam sem estragar; esta
   * vence.
   */
  exclusoes: number | null
  leads: number | null
  mensagens: number | null
  inadimplentes: number | null
  /**
   * As três contagens do estoque (MOD-ESTOQUE-09), numa consulta só.
   *
   * Leitura de estado, como quase todas as outras: a entrada que repõe o produto apaga a
   * linha sozinha. Nulo também quando o plano não tem estoque — o sino não pergunta, em
   * vez de colecionar 402.
   */
  estoque: InventoryAlerts | null
}

/**
 * Janela das falhas de mensagem: 24 horas corridas, e não o dia do calendário.
 *
 * Exportada porque a linha do painel **anuncia** a janela ("nas últimas 24 horas") e
 * quem consulta o serviço a **aplica**. Se o número morasse nos dois lugares, o
 * primeiro ajuste deixaria o texto mentindo sobre o próprio dado.
 */
export const JANELA_HORAS = 24

/**
 * Quanto uma conversa pode esperar na fila antes de virar pendência (MOD-AI-06).
 *
 * Reexportado de `@petshop/shared-types` para a linha do painel **anunciar** o mesmo
 * número que o servidor aplica no filtro. O texto e o recorte moram em lugares
 * diferentes, e é assim que um deles começa a mentir sobre o outro.
 */
export { AGENT_SLA_MIN }

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
   * Na frente de tudo, inclusive dos pedidos de horário.
   *
   * É a única linha em que a espera é de uma **pessoa**, e não de uma tarefa: o cliente
   * mandou mensagem, viu a bolinha de entregue e está olhando para a tela. Dez minutos
   * ali valem mais que um dia de qualquer outra fila.
   */
  if (contagem.atendimentos) {
    linhas.push({
      key: 'atendimentos',
      count: contagem.atendimentos,
      titulo: plural(
        contagem.atendimentos,
        'cliente esperando no WhatsApp',
        'clientes esperando no WhatsApp',
      ),
      detalhe: `sem resposta há mais de ${AGENT_SLA_MIN} minutos`,
      href: '/crm/atendimentos',
    })
  }

  /**
   * Depois dos atendimentos: é a primeira pendência com **prazo**.
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
   * Logo abaixo dos pedidos, porque é o parente mais próximo deles: as duas linhas
   * falam do mesmo tutor marcando no mesmo Portal, e o que as separa é a triagem estar
   * ligada ou não. Juntas, elas nunca contam o mesmo agendamento duas vezes — quem
   * espera aprovação é `PENDING`, e a contagem daqui não olha para esse estado.
   */
  if (contagem.novosAgendamentos?.count) {
    const { count, nextDate } = contagem.novosAgendamentos
    linhas.push({
      key: 'novosAgendamentos',
      count,
      titulo: plural(count, 'agendamento novo pelo site', 'agendamentos novos pelo site'),
      detalhe: 'marcados pelo tutor desde sua última visita',
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
      href: '/configuracoes/estabelecimento?aba=privacidade',
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

  /**
   * O estoque fecha a lista: nenhuma das três linhas é uma pessoa esperando nem um prazo
   * de lei. Entre elas, a validade vem primeiro porque é a única que estraga sozinha — o
   * lote que vence na sexta não espera a compra da semana que vem.
   *
   * O saldo negativo vem antes da reposição: é um registro que falta (o atendimento tirou
   * da prateleira o que nunca entrou), e até alguém conferir, o número de "repor" também
   * está errado.
   */
  if (contagem.estoque?.expiringLots) {
    const { expiringLots, expiryWarningDays } = contagem.estoque
    linhas.push({
      key: 'lotesVencendo',
      count: expiringLots,
      titulo: plural(expiringLots, 'lote vencendo', 'lotes vencendo'),
      detalhe: `validade em até ${expiryWarningDays} dias, ou já vencidos`,
      href: '/estoque?alerta=EXPIRING',
    })
  }

  if (contagem.estoque?.negativeProducts) {
    const { negativeProducts } = contagem.estoque
    linhas.push({
      key: 'saldoNegativo',
      count: negativeProducts,
      titulo: plural(negativeProducts, 'produto com saldo negativo', 'produtos com saldo negativo'),
      detalhe: 'saiu mais do que entrou — confira a contagem',
      href: '/estoque?alerta=NEGATIVE',
    })
  }

  if (contagem.estoque?.lowProducts) {
    const { lowProducts } = contagem.estoque
    linhas.push({
      key: 'produtosRepor',
      count: lowProducts,
      titulo: plural(lowProducts, 'produto para repor', 'produtos para repor'),
      detalhe: 'abaixo do ponto de reposição',
      href: '/estoque?alerta=LOW',
    })
  }

  return linhas
}
