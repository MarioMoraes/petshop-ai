/**
 * "Que dia é hoje" para um estabelecimento.
 *
 * O servidor roda em UTC e o petshop não. Toda vez que o produto responde "hoje" — o
 * caixa do dia, a agenda do dia, a saudação — a pergunta é sobre o fuso do
 * estabelecimento, e responder em UTC erra por três horas no Brasil: o movimento da
 * noite aparece no dia seguinte, e o caixa fecha antes de o petshop fechar.
 *
 * Sem biblioteca de fuso: `Intl` já carrega o banco de dados de fusos do sistema, e é
 * ele que sabe quando o horário de verão entra e sai.
 */

/** `2026-08-26` no fuso pedido — o formato que as rotas de data usam. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // `en-CA` formata como `YYYY-MM-DD`, que é exatamente o que se quer montar de volta.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now)
}

/**
 * Quanto o fuso está deslocado de UTC **naquele instante** — em milissegundos.
 *
 * Precisa ser por instante, e não uma constante: São Paulo já foi UTC-2 no verão, e um
 * deslocamento fixo erraria metade do ano em qualquer lugar que ainda pratique horário
 * de verão.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)

  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // `hour12: false` ainda produz "24" à meia-noite em algumas versões do ICU.
    get('hour') % 24,
    get('minute'),
    get('second'),
    // `formatToParts` não reporta milissegundos, e sem devolvê-los aqui o
    // deslocamento sairia até 999ms maior que o real — o bastante para o fim do dia
    // vazar para o dia seguinte. Deslocamento de fuso é sempre em minutos inteiros,
    // então os milissegundos do instante atravessam intactos.
    instant.getUTCMilliseconds(),
  )

  return asIfUtc - instant.getTime()
}

/**
 * O instante UTC de um horário local.
 *
 * A conta é iterativa por um motivo real: o deslocamento depende do instante, e o
 * instante é o que se está calculando. Uma passada resolve todos os casos comuns; a
 * segunda cobre a virada do horário de verão, em que o palpite inicial cai do lado
 * errado da mudança.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  let instant = new Date(naive - offsetMsAt(new Date(naive), timeZone))
  instant = new Date(naive - offsetMsAt(instant, timeZone))
  return instant
}

/**
 * O dia inteiro de um estabelecimento, em instantes UTC.
 *
 * `2026-08-26` em São Paulo é de `2026-08-26T03:00Z` a `2026-08-27T02:59:59.999Z` —
 * e é essa janela que uma consulta por `received_at` precisa usar. Montar
 * `2026-08-26T00:00Z`–`2026-08-26T23:59Z` é o erro que parece certo e joga três horas
 * de movimento para o dia errado.
 */
export function zonedDayRange(
  dateISO: string,
  timeZone: string,
): { from: Date; to: Date } {
  const [year, month, day] = dateISO.split('-').map(Number) as [number, number, number]

  return {
    from: zonedTimeToUtc(year, month, day, 0, 0, 0, 0, timeZone),
    to: zonedTimeToUtc(year, month, day, 23, 59, 59, 999, timeZone),
  }
}
