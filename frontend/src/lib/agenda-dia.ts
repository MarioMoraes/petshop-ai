import { addDays, weekdayOf } from '@petshop/shared-types'

/**
 * A aritmética da linha do tempo da Agenda do Dia.
 *
 * Puro de propósito, como `lib/pendencias.ts`: nada aqui toca rede, `window` ou
 * `server-only`. Posicionar um bloco na altura certa é a única coisa desta tela que dá
 * para errar em silêncio — um atendimento 45 minutos acima do lugar continua desenhando
 * bonito —, então é a única que precisa de teste.
 *
 * **Tudo aqui conta minutos desde a meia-noite do estabelecimento**, nunca do
 * navegador. A jornada já chega assim do serviço (`shifts[].startsAtMin`); o
 * atendimento chega como instante ISO e passa por `minutosNoFuso`. Misturar as duas
 * referências desenharia a jornada num lugar e os banhos em outro para toda equipe que
 * não estivesse no fuso do petshop.
 */

export const MINUTOS_NO_DIA = 24 * 60

/**
 * O status do agendamento em português.
 *
 * Mora aqui, e não na tela, porque duas telas o usam — a linha do tempo põe no
 * `aria-label` do bloco, a ficha põe na etiqueta — e uma cópia em cada lado divergiria
 * no primeiro status novo.
 */
export const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Aguardando aprovação',
  CONFIRMED: 'Confirmado',
  CHECKED_IN: 'Chegou',
  IN_PROGRESS: 'Em atendimento',
  COMPLETED: 'Concluído',
  NO_SHOW: 'Faltou',
  CANCELLED: 'Cancelado',
  RESCHEDULED: 'Remarcado',
}

/** Piso da faixa desenhada, quando o dia não tem jornada nem atendimento. */
const ABERTURA_PADRAO = 8 * 60
const FECHAMENTO_PADRAO = 18 * 60

/**
 * Menor altura aceitável da faixa, em minutos.
 *
 * Um dia com um único banho às 14h teria janela de 60 minutos e viraria uma tira de
 * 84px — tecnicamente correta e ilegível. Seis horas é o mínimo em que o dia ainda
 * parece um dia.
 */
const JANELA_MINIMA = 6 * 60

export interface Intervalo {
  inicioMin: number
  fimMin: number
}

/**
 * Minutos desde a meia-noite **do estabelecimento** (RN-12).
 *
 * `hourCycle: 'h23'` e não `hour12: false`: em algumas locales o segundo devolve `24`
 * para a meia-noite, e o bloco da 0h iria parar no pé da tela em vez do topo.
 */
export function minutosNoFuso(iso: string, timeZone: string): number {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso))

  const valor = (tipo: 'hour' | 'minute'): number =>
    Number(partes.find((parte) => parte.type === tipo)?.value ?? '0')

  return valor('hour') * 60 + valor('minute')
}

/**
 * O mesmo instante, mas ciente de que ele pode cair em **outro dia**.
 *
 * Um banho marcado para 23h30 com uma hora de duração termina às 0h30 do dia seguinte,
 * e `minutosNoFuso` devolveria 30 — o bloco viraria do avesso, com fim antes do início.
 * Comparando o dia civil do instante com o dia da tela, o fim vira 1470 e o bloco é
 * cortado na borda por `recortar`.
 */
function minutosRelativos(iso: string, timeZone: string, dia: string): number {
  const minutos = minutosNoFuso(iso, timeZone)
  const diaDoInstante = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso))
  if (diaDoInstante === dia) return minutos
  return diaDoInstante < dia ? minutos - MINUTOS_NO_DIA : minutos + MINUTOS_NO_DIA
}

/** Um intervalo qualquer da tela, já reduzido a minutos do dia. */
export function intervaloDe(
  startsAt: string,
  endsAt: string,
  timeZone: string,
  dia: string,
): Intervalo {
  return {
    inicioMin: minutosRelativos(startsAt, timeZone, dia),
    fimMin: minutosRelativos(endsAt, timeZone, dia),
  }
}

/** Corta o intervalo na borda da faixa desenhada. Devolve `null` se ele não a toca. */
export function recortar(intervalo: Intervalo, janela: Intervalo): Intervalo | null {
  const inicioMin = Math.max(intervalo.inicioMin, janela.inicioMin)
  const fimMin = Math.min(intervalo.fimMin, janela.fimMin)
  return fimMin > inicioMin ? { inicioMin, fimMin } : null
}

/**
 * A faixa de horas que a tela desenha.
 *
 * Sai do que o dia **tem** — jornadas, atendimentos e bloqueios —, e não de um horário
 * comercial fixo: o banho de emergência das 6h da manhã precisa aparecer, e um petshop
 * que fecha às 20h não pode ter as duas últimas horas cortadas.
 *
 * Depois de somar tudo, três correções: arredonda para a hora cheia dos dois lados
 * (senão a calha começa em "07:43"), garante o piso de 08:00–18:00 para que um dia
 * vazio ainda pareça um dia de trabalho, e estica até `JANELA_MINIMA`.
 */
export function janelaDoDia(intervalos: Intervalo[]): Intervalo {
  let inicioMin = ABERTURA_PADRAO
  let fimMin = FECHAMENTO_PADRAO

  for (const intervalo of intervalos) {
    if (intervalo.fimMin <= intervalo.inicioMin) continue
    inicioMin = Math.min(inicioMin, intervalo.inicioMin)
    fimMin = Math.max(fimMin, intervalo.fimMin)
  }

  inicioMin = Math.max(0, Math.floor(inicioMin / 60) * 60)
  fimMin = Math.min(MINUTOS_NO_DIA, Math.ceil(fimMin / 60) * 60)

  // Estica para baixo primeiro; só invade a madrugada se não houver folga no fim do dia.
  if (fimMin - inicioMin < JANELA_MINIMA) {
    fimMin = Math.min(MINUTOS_NO_DIA, inicioMin + JANELA_MINIMA)
    inicioMin = Math.max(0, fimMin - JANELA_MINIMA)
  }

  return { inicioMin, fimMin }
}

/**
 * As faixas da janela que **não** são jornada de trabalho.
 *
 * O que está fora do expediente recebe um véu na coluna, e o desenho precisa da
 * ausência, não da presença: a jornada vem em pedaços (manhã e tarde, com o almoço no
 * meio) e o complemento deles dentro da faixa é o que se pinta.
 *
 * Jornada vazia devolve a janela inteira, e é a informação certa — o profissional não
 * tem expediente configurado neste dia da semana.
 */
export function forasDaJornada(janela: Intervalo, jornadas: Intervalo[]): Intervalo[] {
  const validas = jornadas
    .filter((jornada) => jornada.fimMin > jornada.inicioMin)
    .sort((a, b) => a.inicioMin - b.inicioMin)

  const foras: Intervalo[] = []
  let cursor = janela.inicioMin

  for (const jornada of validas) {
    const inicio = Math.max(jornada.inicioMin, janela.inicioMin)
    const fim = Math.min(jornada.fimMin, janela.fimMin)
    if (fim <= cursor) continue
    if (inicio > cursor) foras.push({ inicioMin: cursor, fimMin: inicio })
    cursor = fim
  }

  if (cursor < janela.fimMin) foras.push({ inicioMin: cursor, fimMin: janela.fimMin })
  return foras
}

export interface ComPistas<T> {
  item: T
  intervalo: Intervalo
  /** Coluna dentro da coluna, a partir de zero. */
  pista: number
  /** Quantas pistas o **grupo sobreposto** deste item precisou. */
  pistas: number
}

/**
 * Reparte itens sobrepostos em pistas lado a lado.
 *
 * Um profissional com `maxConcurrentPets > 1` atende dois pets ao mesmo tempo, e é a
 * regra do próprio catálogo — não uma inconsistência a esconder. Sem repartir, os dois
 * blocos ocupam o mesmo retângulo e o de baixo simplesmente desaparece.
 *
 * A largura sai do **grupo**, não da coluna inteira: um dia com quatro banhos em fila e
 * dois sobrepostos às 15h tem 1 pista até as 15h e 2 depois. Dividindo pela coluna
 * inteira, os quatro blocos ficariam com metade da largura o dia todo por causa de um
 * cruzamento de dez minutos.
 *
 * O grupo fecha quando um item começa depois do fim de **todos** os anteriores — daí o
 * `maiorFim` acumulado em vez do fim do item anterior: A(8h–12h), B(9h–10h), C(11h–13h)
 * é um grupo só, mesmo B e C não se tocando.
 */
export function distribuirPistas<T>(
  itens: { item: T; intervalo: Intervalo }[],
): ComPistas<T>[] {
  const ordenados = [...itens].sort(
    (a, b) => a.intervalo.inicioMin - b.intervalo.inicioMin || a.intervalo.fimMin - b.intervalo.fimMin,
  )

  const resultado: ComPistas<T>[] = []
  /** Índices em `resultado` do grupo aberto. */
  let grupo: number[] = []
  /** Fim de cada pista do grupo aberto. */
  let fimDaPista: number[] = []
  let maiorFim = -Infinity

  function fecharGrupo(): void {
    const pistas = Math.max(1, fimDaPista.length)
    for (const indice of grupo) resultado[indice]!.pistas = pistas
    grupo = []
    fimDaPista = []
    maiorFim = -Infinity
  }

  for (const { item, intervalo } of ordenados) {
    if (intervalo.inicioMin >= maiorFim) fecharGrupo()

    let pista = fimDaPista.findIndex((fim) => fim <= intervalo.inicioMin)
    if (pista === -1) {
      pista = fimDaPista.length
      fimDaPista.push(intervalo.fimMin)
    } else {
      fimDaPista[pista] = intervalo.fimMin
    }

    grupo.push(resultado.length)
    resultado.push({ item, intervalo, pista, pistas: 1 })
    maiorFim = Math.max(maiorFim, intervalo.fimMin)
  }

  fecharGrupo()
  return resultado
}

/** `hh:mm` a partir de minutos do dia. Serve à calha de horas e à jornada. */
export function horaDe(minutos: number): string {
  const total = ((minutos % MINUTOS_NO_DIA) + MINUTOS_NO_DIA) % MINUTOS_NO_DIA
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** As horas cheias que a calha rotula. */
export function horasDaJanela(janela: Intervalo): number[] {
  const horas: number[] = []
  for (let minuto = janela.inicioMin; minuto < janela.fimMin; minuto += 60) horas.push(minuto)
  return horas
}

export interface DiaDaFaixa {
  date: string
  /** Inicial do dia da semana, para a linha de cima da pastilha. */
  inicial: string
  /** Número do dia no mês. */
  numero: number
  fimDeSemana: boolean
}

const INICIAIS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'] as const

/**
 * Os sete dias da faixa, com o dia escolhido no meio.
 *
 * Centrado e não "a semana de domingo a sábado": quem está numa quinta-feira quer ver
 * a quarta e a sexta, e uma faixa alinhada à semana civil deixaria a sexta na semana
 * seguinte — a dois cliques de distância para andar um dia.
 */
export function faixaDeDias(dateISO: string): DiaDaFaixa[] {
  return [-3, -2, -1, 0, 1, 2, 3].map((deslocamento) => {
    const date = addDays(dateISO, deslocamento)
    const semana = weekdayOf(date)
    return {
      date,
      inicial: INICIAIS[semana]!,
      numero: Number(date.slice(8, 10)),
      fimDeSemana: semana === 0 || semana === 6,
    }
  })
}

/** "segunda-feira, 1 de setembro" — o cabeçalho da tela diz que dia é este. */
export function rotuloDoDia(dateISO: string): string {
  return new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}
