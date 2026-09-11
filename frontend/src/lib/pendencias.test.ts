import { describe, expect, it } from 'vitest'
import { chavesAMarcar, contarNaoVistos, montarPendencias, type Pendencia } from './pendencias'

/**
 * O sino mostra trabalho pendente, e a regra que mais importa é a que separa **zero**
 * de **não sei**: uma pessoa sem permissão para Financeiro não pode ver o sino jurar
 * que não há inadimplente nenhum.
 */
describe('montarPendencias', () => {
  const nada = {
    atendimentos: null,
    aprovacoes: null,
    novosAgendamentos: null,
    exclusoes: null,
    leads: null,
    mensagens: null,
    inadimplentes: null,
  }

  it('não mostra linha para contagem zero — ausência de trabalho não é aviso', () => {
    expect(montarPendencias({ ...nada, leads: 0, mensagens: 0, inadimplentes: 0 })).toEqual([])
  })

  it('não mostra linha para o que não foi apurado', () => {
    expect(montarPendencias(nada)).toEqual([])
  })

  it('trata "não apurado" e zero do mesmo jeito na tela, por caminhos diferentes', () => {
    // Some das duas formas, mas por motivos distintos: o teste existe para que
    // trocar `null` por `0` em `carregarPendencias` não passe despercebido.
    expect(montarPendencias({ ...nada, mensagens: 2, inadimplentes: 0 })).toHaveLength(1)
  })

  it('conta cada fonte na sua própria linha, na ordem do fluxo de trabalho', () => {
    const linhas = montarPendencias({
      atendimentos: 2,
      aprovacoes: { count: 4, nextDate: '2026-09-10' },
      novosAgendamentos: { count: 2, nextDate: '2026-09-11' },
      exclusoes: 1,
      leads: 3,
      mensagens: 2,
      inadimplentes: 1,
    })
    /**
     * O cliente esperando no WhatsApp abre a lista, e as duas com prazo vêm logo atrás,
     * na ordem em que apertam.
     *
     * Primeiro porque é a única espera de uma **pessoa**: ela mandou mensagem, viu a
     * bolinha de entregue e está olhando para a tela. As outras são tarefas paradas.
     *
     * A triagem do Portal primeiro: o horário reservado expira em 24h e leva o cliente
     * junto. O pedido de exclusão logo depois: o prazo dele é de quinze dias, mas é de
     * **lei** — contato do site e inadimplente esperam sem estragar.
     *
     * O aviso de agendamento novo vem colado na triagem por ser o parente dela: mesmo
     * tutor, mesmo Portal, e o que separa as duas é a triagem estar ligada ou não.
     */
    expect(linhas.map((l) => l.key)).toEqual([
      'atendimentos',
      'aprovacoes',
      'novosAgendamentos',
      'exclusoes',
      'leads',
      'mensagens',
      'inadimplentes',
    ])
  })

  it('leva a contagem inteira para a linha, sem novo recorte', () => {
    const [linha] = montarPendencias({ ...nada, mensagens: 7 })
    expect(linha?.count).toBe(7)
  })

  describe('plural', () => {
    it('usa o singular para um', () => {
      expect(montarPendencias({ ...nada, leads: 1 })[0]?.titulo).toBe('1 contato do site')
      expect(montarPendencias({ ...nada, mensagens: 1 })[0]?.titulo).toBe('1 mensagem não saiu')
      expect(montarPendencias({ ...nada, inadimplentes: 1 })[0]?.titulo).toBe(
        '1 tutor inadimplente',
      )
    })

    it('usa o plural para os demais', () => {
      expect(montarPendencias({ ...nada, leads: 4 })[0]?.titulo).toBe('4 contatos do site')
      expect(montarPendencias({ ...nada, mensagens: 4 })[0]?.titulo).toBe('4 mensagens não saíram')
      expect(montarPendencias({ ...nada, inadimplentes: 4 })[0]?.titulo).toBe(
        '4 tutores inadimplentes',
      )
    })
  })

  /*
   * O destino de Mensagens é `DEAD` e não `FAILED` de propósito: `FAILED` volta para
   * a fila sozinha, e o sino só chama gente para o que ninguém mais vai tentar.
   */
  it('aponta cada linha para a tela que resolve a pendência, já filtrada', () => {
    const linhas = montarPendencias({
      atendimentos: 1,
      aprovacoes: { count: 1, nextDate: '2026-09-10' },
      novosAgendamentos: { count: 1, nextDate: '2026-09-11' },
      exclusoes: 1,
      leads: 1,
      mensagens: 1,
      inadimplentes: 1,
    })
    expect(linhas.map((l) => l.href)).toEqual([
      // A fila de atendimento abre no padrão dela, que já é quem está esperando.
      '/crm/atendimentos',
      '/agenda/dia?date=2026-09-10',
      '/agenda/dia?date=2026-09-11',
      // A aba já selecionada: sem o `?aba=`, o clique cairia em "Dados" e o contador
      // teria prometido um destino para entregar outro.
      '/configuracoes?aba=privacidade',
      '/site/contatos?status=NEW',
      '/crm?status=DEAD',
      '/tutores?tag=INADIMPLENTE',
    ])
  })

  /*
   * A visão da agenda é por dia. Sem o dia do pedido mais próximo, o link cairia em
   * "hoje" e abriria uma tela sem nenhum dos pedidos que o sino acabou de anunciar.
   */
  it('leva a triagem para o dia do pedido mais próximo, e cai em hoje se ele faltar', () => {
    const comDia = montarPendencias({ ...nada, aprovacoes: { count: 2, nextDate: '2026-12-24' } })
    expect(comDia[0]?.href).toBe('/agenda/dia?date=2026-12-24')

    const semDia = montarPendencias({ ...nada, aprovacoes: { count: 2, nextDate: null } })
    expect(semDia[0]?.href).toBe('/agenda/dia')
  })

  it('não mostra a triagem quando a fila está vazia', () => {
    expect(montarPendencias({ ...nada, aprovacoes: { count: 0, nextDate: null } })).toEqual([])
  })

  /*
   * A linha que não é pendência, e a única com marca de lido. Ela some pelo mesmo
   * caminho das outras — contagem zero —, e é isso que mantém `montarPendencias` sem
   * saber que existe estado de lido em algum lugar.
   */
  describe('agendamento novo pelo Portal', () => {
    it('anuncia a novidade com o dia para onde ir', () => {
      const [linha] = montarPendencias({
        ...nada,
        novosAgendamentos: { count: 3, nextDate: '2026-09-20' },
      })
      expect(linha?.titulo).toBe('3 agendamentos novos pelo site')
      expect(linha?.href).toBe('/agenda/dia?date=2026-09-20')
    })

    it('usa o singular para um', () => {
      const [linha] = montarPendencias({
        ...nada,
        novosAgendamentos: { count: 1, nextDate: null },
      })
      expect(linha?.titulo).toBe('1 agendamento novo pelo site')
      expect(linha?.href).toBe('/agenda/dia')
    })

    it('some quando tudo já foi visto — é o que a marca de lido faz com a contagem', () => {
      expect(
        montarPendencias({ ...nada, novosAgendamentos: { count: 0, nextDate: null } }),
      ).toEqual([])
    })
  })
})

/**
 * A aritmética do ponto vermelho, fora do componente.
 *
 * O painel abre por clique, e comportamento que depende de JavaScript não se verifica
 * pela receita de captura do projeto — então ele é testado aqui, como função pura.
 */
describe('o ponto vermelho e a marca de lido', () => {
  const linhas = montarPendencias({
    atendimentos: null,
    aprovacoes: { count: 2, nextDate: '2026-09-10' },
    novosAgendamentos: { count: 3, nextDate: '2026-09-11' },
    exclusoes: null,
    leads: 4,
    mensagens: null,
    inadimplentes: null,
  })

  it('soma tudo enquanto nada foi visto', () => {
    expect(contarNaoVistos(linhas, [])).toBe(9)
  })

  it('desconta a linha inteira depois de vista — não há novidade pela metade', () => {
    expect(contarNaoVistos(linhas, ['novosAgendamentos'])).toBe(6)
  })

  /*
   * O caso que a lista `CHAVES_COM_LEITURA` existe para garantir. Marcar tudo ao abrir
   * o painel apagaria pedido de aprovação e contato do site — trabalho que continua
   * parado depois de alguém ter só olhado.
   */
  it('só marca o que não é pendência de verdade', () => {
    expect(chavesAMarcar(linhas, [])).toEqual(['novosAgendamentos'])
  })

  it('não remarca o que esta abertura já marcou — sem ida ao servidor à toa', () => {
    expect(chavesAMarcar(linhas, ['novosAgendamentos'])).toEqual([])
  })

  it('nada a marcar quando o painel não tem a linha de novidade', () => {
    const semNovidade: Pendencia[] = montarPendencias({
      atendimentos: null,
      aprovacoes: null,
      novosAgendamentos: null,
      exclusoes: null,
      leads: 1,
      mensagens: null,
      inadimplentes: null,
    })
    expect(chavesAMarcar(semNovidade, [])).toEqual([])
    expect(contarNaoVistos(semNovidade, [])).toBe(1)
  })
})
