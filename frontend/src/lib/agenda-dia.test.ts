import { describe, expect, it } from 'vitest'
import {
  distribuirPistas,
  faixaDeDias,
  horaDe,
  horasDaJanela,
  intervaloDe,
  forasDaJornada,
  janelaDoDia,
  minutosNoFuso,
  recortar,
  alvoDaRolagem,
} from './agenda-dia'

const SP = 'America/Sao_Paulo'
/** O fuso mais a oeste do país, e o pior caso do teste de `timezone.ts`. */
const RIO_BRANCO = 'America/Rio_Branco'

describe('minutosNoFuso', () => {
  it('conta a partir da meia-noite do estabelecimento, não do UTC', () => {
    // 11:00Z é 08:00 em São Paulo (UTC−3) e 06:00 em Rio Branco (UTC−5).
    expect(minutosNoFuso('2026-09-01T11:00:00Z', SP)).toBe(8 * 60)
    expect(minutosNoFuso('2026-09-01T11:00:00Z', RIO_BRANCO)).toBe(6 * 60)
  })

  it('devolve zero na meia-noite, e não 1440', () => {
    expect(minutosNoFuso('2026-09-01T03:00:00Z', SP)).toBe(0)
  })
})

describe('intervaloDe', () => {
  it('mede o atendimento dentro do dia', () => {
    expect(
      intervaloDe('2026-09-01T11:00:00Z', '2026-09-01T12:30:00Z', SP, '2026-09-01'),
    ).toEqual({ inicioMin: 480, fimMin: 570 })
  })

  it('estende para além de 1440 o que termina no dia seguinte', () => {
    // 23h30 de 01/09 até 00h30 de 02/09, hora de São Paulo.
    const intervalo = intervaloDe(
      '2026-09-02T02:30:00Z',
      '2026-09-02T03:30:00Z',
      SP,
      '2026-09-01',
    )
    expect(intervalo).toEqual({ inicioMin: 1410, fimMin: 1470 })
    expect(intervalo.fimMin).toBeGreaterThan(intervalo.inicioMin)
  })
})

describe('recortar', () => {
  const janela = { inicioMin: 480, fimMin: 1080 }

  it('corta na borda o que atravessa a faixa', () => {
    expect(recortar({ inicioMin: 400, fimMin: 1200 }, janela)).toEqual(janela)
  })

  it('devolve nulo para o que não toca a faixa', () => {
    expect(recortar({ inicioMin: 60, fimMin: 120 }, janela)).toBeNull()
  })

  it('devolve nulo para intervalo degenerado na borda', () => {
    expect(recortar({ inicioMin: 200, fimMin: 480 }, janela)).toBeNull()
  })
})

describe('janelaDoDia', () => {
  it('cai no horário comercial quando o dia está vazio', () => {
    expect(janelaDoDia([])).toEqual({ inicioMin: 480, fimMin: 1080 })
  })

  it('abre antes das 8h para o atendimento de madrugada', () => {
    expect(janelaDoDia([{ inicioMin: 5 * 60 + 30, fimMin: 6 * 60 }])).toEqual({
      inicioMin: 300,
      fimMin: 1080,
    })
  })

  it('arredonda as bordas para a hora cheia', () => {
    const janela = janelaDoDia([{ inicioMin: 7 * 60 + 43, fimMin: 19 * 60 + 12 }])
    expect(janela).toEqual({ inicioMin: 420, fimMin: 1200 })
  })

  it('respeita o piso de seis horas num dia de um atendimento só', () => {
    // Sem o piso, uma jornada de 14h às 15h desenharia uma tira de uma hora.
    const janela = janelaDoDia([{ inicioMin: 14 * 60, fimMin: 15 * 60 }])
    expect(janela.fimMin - janela.inicioMin).toBeGreaterThanOrEqual(6 * 60)
    expect(janela.inicioMin).toBeLessThanOrEqual(14 * 60)
    expect(janela.fimMin).toBeGreaterThanOrEqual(15 * 60)
  })

  it('ignora intervalo degenerado', () => {
    expect(janelaDoDia([{ inicioMin: 60, fimMin: 60 }])).toEqual({ inicioMin: 480, fimMin: 1080 })
  })

  it('não passa da meia-noite', () => {
    const janela = janelaDoDia([{ inicioMin: 23 * 60, fimMin: 24 * 60 }])
    expect(janela.fimMin).toBe(1440)
  })
})

describe('forasDaJornada', () => {
  const janela = { inicioMin: 480, fimMin: 1080 }

  it('vela o dia inteiro quando não há jornada configurada', () => {
    expect(forasDaJornada(janela, [])).toEqual([janela])
  })

  it('recorta o almoço entre a manhã e a tarde', () => {
    const foras = forasDaJornada(janela, [
      { inicioMin: 540, fimMin: 720 },
      { inicioMin: 780, fimMin: 1020 },
    ])
    expect(foras).toEqual([
      { inicioMin: 480, fimMin: 540 },
      { inicioMin: 720, fimMin: 780 },
      { inicioMin: 1020, fimMin: 1080 },
    ])
  })

  it('não devolve nada quando a jornada cobre a faixa inteira', () => {
    expect(forasDaJornada(janela, [{ inicioMin: 400, fimMin: 1200 }])).toEqual([])
  })

  it('funde jornadas sobrepostas em vez de duplicar véu', () => {
    const foras = forasDaJornada(janela, [
      { inicioMin: 540, fimMin: 800 },
      { inicioMin: 700, fimMin: 1020 },
    ])
    expect(foras).toEqual([
      { inicioMin: 480, fimMin: 540 },
      { inicioMin: 1020, fimMin: 1080 },
    ])
  })

  it('ignora jornada inteiramente fora da faixa', () => {
    expect(forasDaJornada(janela, [{ inicioMin: 60, fimMin: 120 }])).toEqual([janela])
  })
})

describe('distribuirPistas', () => {
  const de = (nome: string, inicioMin: number, fimMin: number) => ({
    item: nome,
    intervalo: { inicioMin, fimMin },
  })

  function mapa(resultado: ReturnType<typeof distribuirPistas<string>>) {
    return Object.fromEntries(
      resultado.map((linha) => [linha.item, { pista: linha.pista, pistas: linha.pistas }]),
    )
  }

  it('deixa uma pista só quando nada se sobrepõe', () => {
    const resultado = distribuirPistas([de('a', 480, 540), de('b', 540, 600)])
    expect(mapa(resultado)).toEqual({
      a: { pista: 0, pistas: 1 },
      b: { pista: 0, pistas: 1 },
    })
  })

  it('reparte dois pets atendidos ao mesmo tempo', () => {
    const resultado = distribuirPistas([de('a', 480, 600), de('b', 540, 660)])
    expect(mapa(resultado)).toEqual({
      a: { pista: 0, pistas: 2 },
      b: { pista: 1, pistas: 2 },
    })
  })

  it('chega a três pistas quando três se cruzam', () => {
    const resultado = distribuirPistas([de('a', 480, 660), de('b', 500, 640), de('c', 520, 620)])
    expect(mapa(resultado)).toEqual({
      a: { pista: 0, pistas: 3 },
      b: { pista: 1, pistas: 3 },
      c: { pista: 2, pistas: 3 },
    })
  })

  it('reaproveita a pista que já vagou', () => {
    const resultado = distribuirPistas([de('a', 480, 600), de('b', 540, 660), de('c', 600, 700)])
    // `c` começa quando `a` termina, e volta para a pista 0 em vez de abrir uma terceira.
    expect(mapa(resultado).c).toEqual({ pista: 0, pistas: 2 })
  })

  it('estreita só o grupo sobreposto, não a coluna inteira', () => {
    const resultado = distribuirPistas([
      de('manha', 480, 540),
      de('tarde-a', 840, 960),
      de('tarde-b', 900, 1020),
    ])
    const largura = mapa(resultado)
    expect(largura['manha']).toEqual({ pista: 0, pistas: 1 })
    expect(largura['tarde-a']!.pistas).toBe(2)
    expect(largura['tarde-b']!.pistas).toBe(2)
  })

  it('mede a largura pelo pico do grupo, não pela contagem de cruzamentos', () => {
    // B e C cruzam A mas não cruzam entre si: dividem a mesma pista, e o grupo
    // precisa de duas — não de três.
    const resultado = distribuirPistas([de('a', 480, 720), de('b', 540, 600), de('c', 660, 780)])
    const largura = mapa(resultado)
    expect(largura['a']).toEqual({ pista: 0, pistas: 2 })
    expect(largura['b']).toEqual({ pista: 1, pistas: 2 })
    expect(largura['c']).toEqual({ pista: 1, pistas: 2 })
  })

  it('não altera a lista recebida', () => {
    const entrada = [de('b', 540, 600), de('a', 480, 540)]
    distribuirPistas(entrada)
    expect(entrada[0]!.item).toBe('b')
  })
})

describe('horaDe e horasDaJanela', () => {
  it('formata com dois dígitos', () => {
    expect(horaDe(0)).toBe('00:00')
    expect(horaDe(495)).toBe('08:15')
    expect(horaDe(1439)).toBe('23:59')
  })

  it('dobra a meia-noite do dia seguinte', () => {
    expect(horaDe(1470)).toBe('00:30')
  })

  it('rotula uma hora por linha da calha', () => {
    expect(horasDaJanela({ inicioMin: 480, fimMin: 660 })).toEqual([480, 540, 600])
  })
})

describe('faixaDeDias', () => {
  it('põe o dia escolhido no meio dos sete', () => {
    const faixa = faixaDeDias('2026-09-01')
    expect(faixa).toHaveLength(7)
    expect(faixa[3]!.date).toBe('2026-09-01')
    expect(faixa[0]!.date).toBe('2026-08-29')
    expect(faixa[6]!.date).toBe('2026-09-04')
  })

  it('marca sábado e domingo', () => {
    // 2026-09-01 é uma terça-feira; a faixa começa no sábado 29/08.
    const faixa = faixaDeDias('2026-09-01')
    expect(faixa.map((dia) => dia.fimDeSemana)).toEqual([true, true, false, false, false, false, false])
    expect(faixa[0]!.inicial).toBe('S')
    expect(faixa[3]!.inicial).toBe('T')
  })

  it('atravessa a virada do mês', () => {
    expect(faixaDeDias('2026-09-01')[2]!.numero).toBe(31)
  })
})

describe('alvoDaRolagem', () => {
  const CABECALHO = 96

  it('deixa um terço da caixa de folga acima do agora', () => {
    // Caixa de 720px: 240 de folga, e o fio das 15h a 900px do topo do conteúdo.
    expect(
      alvoDaRolagem({ topoDoFio: 900, alturaCaixa: 720, alturaCabecalho: CABECALHO }),
    ).toBe(660)
  })

  it('numa caixa baixa, a folga é a altura do cabeçalho', () => {
    // Um terço de 210 são 70px — menos que o cabeçalho, que cobriria o fio.
    expect(
      alvoDaRolagem({ topoDoFio: 400, alturaCaixa: 210, alturaCabecalho: CABECALHO }),
    ).toBe(304)
  })

  it('de manhã cedo não rola nada: o começo do dia já é o lugar certo', () => {
    expect(
      alvoDaRolagem({ topoDoFio: 120, alturaCaixa: 720, alturaCabecalho: CABECALHO }),
    ).toBe(0)
  })
})
