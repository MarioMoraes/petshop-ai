/**
 * As conversões que as seis telas do console repetem.
 *
 * Ficam juntas porque divergir aqui é sutil: "há 3 min" numa tela e "16:42" na outra
 * fazem a mesma linha parecer dois eventos quando o operador compara duas abas.
 */

/** "16:42" — o relógio do leitor, que é quem está de plantão. */
export function hora(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

/** "24/08 16:42" — data e hora curtas, para tabela. */
export function quando(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

/** "24 de agosto de 2026" — a versão por extenso, para ficha e não para tabela. */
export function dia(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso))
}

/**
 * "há 3 min", "há 2 h", "há 5 d".
 *
 * O relativo é o que responde à pergunta desta superfície — *isto está parado?* —, e um
 * carimbo absoluto obriga quem lê a fazer a subtração de cabeça. As duas formas aparecem
 * juntas quando o dado é de investigação: relativo para triar, absoluto para casar com o
 * log.
 */
export function desde(iso: string | null): string {
  if (!iso) return '—'

  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'agora'

  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`

  const horas = Math.floor(min / 60)
  if (horas < 24) return `há ${horas} h`

  return `há ${Math.floor(horas / 24)} d`
}

/** "em 12 min" — o futuro, que é como se lê a próxima passada de um job. */
export function daqui(iso: string | null): string {
  if (!iso) return '—'

  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'agora'

  const min = Math.round(ms / 60_000)
  if (min < 1) return 'em menos de 1 min'
  if (min < 60) return `em ${min} min`

  const horas = Math.floor(min / 60)
  if (horas < 24) return `em ${horas} h`

  return `em ${Math.floor(horas / 24)} d`
}

/** "820 ms", "1,4 s" — a duração da última execução. */
export function duracao(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`
}

/** "1,2 GB" — o que o bucket guarda de foto para um estabelecimento. */
export function bytes(total: number): string {
  if (total < 1024) return `${total} B`

  const unidades = ['kB', 'MB', 'GB', 'TB']
  let valor = total / 1024
  let casa = 0
  while (valor >= 1024 && casa < unidades.length - 1) {
    valor /= 1024
    casa += 1
  }

  return `${valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${unidades[casa]}`
}

/** "1.284" — contagem com separador de milhar, que é o que uma coluna de número pede. */
export function numero(valor: number): string {
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
}
