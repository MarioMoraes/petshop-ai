import { describe, expect, it } from 'vitest'
import { montarPendencias } from './pendencias'

/**
 * O sino mostra trabalho pendente, e a regra que mais importa é a que separa **zero**
 * de **não sei**: uma pessoa sem permissão para Financeiro não pode ver o sino jurar
 * que não há inadimplente nenhum.
 */
describe('montarPendencias', () => {
  const nada = { aprovacoes: null, leads: null, mensagens: null, inadimplentes: null }

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
      aprovacoes: { count: 4, nextDate: '2026-09-10' },
      leads: 3,
      mensagens: 2,
      inadimplentes: 1,
    })
    // A triagem do Portal abre a lista: é a única com prazo — o horário reservado
    // expira em 24h e leva o cliente junto.
    expect(linhas.map((l) => l.key)).toEqual([
      'aprovacoes',
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
      expect(montarPendencias({ ...nada, mensagens: 4 })[0]?.titulo).toBe(
        '4 mensagens não saíram',
      )
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
      aprovacoes: { count: 1, nextDate: '2026-09-10' },
      leads: 1,
      mensagens: 1,
      inadimplentes: 1,
    })
    expect(linhas.map((l) => l.href)).toEqual([
      '/agenda/dia?date=2026-09-10',
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
})
