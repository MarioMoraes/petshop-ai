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
export function distribuirPistas<T>(itens: { item: T; intervalo: Intervalo }[]): ComPistas<T>[] {
  const ordenados = [...itens].sort(
    (a, b) =>
      a.intervalo.inicioMin - b.intervalo.inicioMin || a.intervalo.fimMin - b.intervalo.fimMin,
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

/**
 * Onde a caixa da linha do tempo deve parar para mostrar o agora.
 *
 * Função pura, e fora do componente, porque é a única parte do posicionamento que dá
 * para conferir sem um navegador: o resto é `scrollTop` e medida de elemento.
 *
 * **O agora não fica no topo.** Fica com um terço da caixa de folga acima, porque a
 * pergunta do balcão não é só "o que vem agora" — é também "o que acabou de sair da
 * bancada". Colar o fio no topo esconderia a resposta da metade da pergunta.
 *
 * O piso da folga é a **altura do cabeçalho**, que é grudado no topo da caixa e cobriria
 * o fio numa janela baixa. Sem ele, a tela de quem trabalha com o navegador pela metade
 * posicionaria o agora exatamente atrás dos nomes dos profissionais.
 */
export function alvoDaRolagem(medidas: {
  /** Distância do fio do agora até o topo do conteúdo rolável, em pixels. */
  topoDoFio: number
  /** Altura visível da caixa. */
  alturaCaixa: number
  /** Altura do cabeçalho grudado no topo. */
  alturaCabecalho: number
}): number {
  const folga = Math.max(medidas.alturaCabecalho, medidas.alturaCaixa / 3)
  // Manhã cedo: o alvo é negativo e a caixa já está no lugar certo, que é o começo.
  return Math.max(0, medidas.topoDoFio - folga)
}

/**
 * Piso e teto da escala do Mural, em pixels por minuto.
 *
 * O piso é mais baixo que o 1,4 fixo da Agenda do Dia, e de propósito. Num notebook de
 * 900px de altura sobram uns 670px de palco, e um expediente comum de dez horas a 1,4
 * mediria 840px — o Mural voltaria a rolar, que é exatamente o defeito que ele existe
 * para resolver. A 1,0 o atendimento de meia hora, que é o mais curto do catálogo real,
 * fica com 30px: uma linha de texto com o respiro do bloco. O slot de 15 minutos da
 * grade cai abaixo disso e encosta no vizinho, e esse é o preço aceito — no Mural,
 * que só lê, um bloco apertado custa menos que meio dia fora da tela.
 *
 * O teto existe porque a conta é uma divisão: um sábado de duas horas numa televisão
 * daria 7px por minuto, e um banho viraria um painel de 210px com quatro palavras.
 */
const ESCALA_MINIMA = 1.0
const ESCALA_MAXIMA = 3.2

/**
 * Quantos pixels vale um minuto no Mural.
 *
 * É a diferença entre o Mural e a Agenda do Dia. Lá a escala é fixa e a caixa rola: a
 * tela divide espaço com o menu, a faixa de datas e os números do dia, e caberia mesmo
 * assim a metade de uma manhã. Aqui a tela é só o dia, então a escala **se ajusta à
 * altura disponível** e o expediente inteiro entra sem rolagem — que é a única razão de
 * o Mural existir.
 *
 * O ajuste é para os dois lados de propósito. Numa segunda-feira de doze horas ele
 * comprime até o piso e a faixa volta a rolar, porque um dia ilegível inteiro na tela é
 * pior que meio dia legível. Num sábado que fecha ao meio-dia ele estica, e os blocos
 * ganham o espaço que sobrou em vez de deixarem metade da tela vazia.
 */
export function escalaDoMural(medidas: {
  /** Altura útil do palco, já descontado o cabeçalho das colunas. */
  alturaDisponivel: number
  /** Duração da faixa desenhada, em minutos. */
  duracaoMin: number
}): number {
  if (medidas.duracaoMin <= 0 || medidas.alturaDisponivel <= 0) return ESCALA_MINIMA
  const exata = medidas.alturaDisponivel / medidas.duracaoMin
  return Math.min(ESCALA_MAXIMA, Math.max(ESCALA_MINIMA, exata))
}
