/**
 * Interpretador de cron, pequeno e próprio.
 *
 * Cinco campos — `minuto hora dia-do-mês mês dia-da-semana` — com `*`, número, faixa
 * (`1-5`), lista (`1,15`) e passo (`*` /15). É o que a grade do §10 usa e nada além.
 *
 * Trazer uma biblioteca de cron completa significaria carregar segundos, `L`, `W`, `#`
 * e o histórico de CVEs de um parser genérico para expressar oito linhas de grade.
 * Mesma decisão que o `parseRRule` do MOD-AGENDA tomou com o iCal.
 *
 * **O relógio é avaliado no fuso do estabelecimento**, não em UTC. O SLO do §10 fala em
 * "03:00 BRT"; escrever a grade em UTC obrigaria a corrigi-la duas vezes por ano, e o
 * job de madrugada passaria a rodar às 4h no horário de verão. `Intl.DateTimeFormat`
 * resolve isso sem dependência nenhuma.
 */

export interface CronExpression {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  /** 0 = domingo, como manda o cron. */
  dayOfWeek: Set<number>
  source: string
}

interface FieldSpec {
  min: number
  max: number
  label: string
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, label: 'minuto' },
  { min: 0, max: 23, label: 'hora' },
  { min: 1, max: 31, label: 'dia do mês' },
  { min: 1, max: 12, label: 'mês' },
  { min: 0, max: 6, label: 'dia da semana' },
]

export function parseCron(source: string): CronExpression {
  const parts = source.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Expressão cron inválida (esperados 5 campos): "${source}"`)
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) =>
    parseField(part as string, FIELDS[index] as FieldSpec),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]

  return { minute, hour, dayOfMonth, month, dayOfWeek, source }
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>()

  for (const chunk of raw.split(',')) {
    const [range, stepText] = chunk.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Passo inválido no campo ${spec.label}: "${chunk}"`)
    }

    let from: number
    let to: number

    if (range === '*' || range === undefined) {
      from = spec.min
      to = spec.max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      from = a as number
      to = b as number
    } else {
      from = Number(range)
      // `5/15` sem faixa significa "de 5 até o fim, de 15 em 15" — a mesma leitura do
      // cron do Vixie. Sem passo, é um valor só.
      to = step === 1 ? from : spec.max
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < spec.min || to > spec.max) {
      throw new Error(`Valor fora da faixa no campo ${spec.label}: "${chunk}"`)
    }

    for (let value = from; value <= to; value += step) values.add(value)
  }

  return values
}

interface LocalParts {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/**
 * Decompõe o instante nos campos do cron, **no fuso pedido**.
 *
 * `formatToParts` é a única forma de fazer isso sem uma biblioteca de fuso: `getHours()`
 * daria a hora do servidor, que em produção é UTC e em desenvolvimento é a do laptop —
 * as duas erradas para uma grade escrita em horário de Brasília.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Um formatador por fuso, guardado.
 *
 * Construir um `Intl.DateTimeFormat` é a parte cara da conversão, e o `nextMatch` a
 * repete milhares de vezes seguidas ao varrer a grade. O tique do agendador chama uma vez
 * por minuto e não notaria; a previsão do painel de saúde notaria muito.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0'

  return {
    // `hour12: false` ainda produz "24" à meia-noite em algumas versões do ICU.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    dayOfMonth: Number(get('day')),
    month: Number(get('month')),
    dayOfWeek: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

/**
 * O instante casa com a expressão?
 *
 * Regra do cron original para dia: quando **os dois** campos de dia são restritos, vale
 * a **união** (`0 0 1 * 1` roda no dia 1 e às segundas). Quando só um é restrito, vale
 * ele. É contraintuitivo, mas é o que qualquer operador espera de um cron.
 */
export function matches(expression: CronExpression, date: Date, timeZone: string): boolean {
  const parts = localParts(date, timeZone)

  if (!expression.minute.has(parts.minute)) return false
  if (!expression.hour.has(parts.hour)) return false
  if (!expression.month.has(parts.month)) return false

  const dayOfMonthRestricted = expression.dayOfMonth.size < 31
  const dayOfWeekRestricted = expression.dayOfWeek.size < 7

  const monthDayHit = expression.dayOfMonth.has(parts.dayOfMonth)
  const weekDayHit = expression.dayOfWeek.has(parts.dayOfWeek)

  if (dayOfMonthRestricted && dayOfWeekRestricted) return monthDayHit || weekDayHit
  if (dayOfMonthRestricted) return monthDayHit
  if (dayOfWeekRestricted) return weekDayHit
  return true
}

/**
 * A próxima passada depois de `from`, ou `null` se não houver nenhuma em oito dias.
 *
 * **Varre minuto a minuto, e o teto de oito dias é o que a torna barata.** A grade do
 * produto vai de "todo minuto" a "domingo às 3h30", então oito dias cobrem todas — e uma
 * expressão que só case daqui a meses (`0 0 29 2 *`) devolve `null` em vez de custar
 * meio milhão de conversões de fuso. Nulo aqui é "não sabemos", não "nunca".
 *
 * O formatador é criado **uma vez** e reusado pelos 11.520 minutos do pior caso:
 * `localParts` monta um `Intl.DateTimeFormat` por chamada, que é a parte cara.
 */
const NEXT_MATCH_HORIZON_MINUTES = 8 * 24 * 60

export function nextMatch(
  expression: CronExpression,
  from: Date,
  timeZone: string,
): Date | null {
  // O cron tem resolução de minuto: começa no minuto cheio seguinte ao instante dado.
  const cursor = new Date(from.getTime() + 60_000)
  cursor.setUTCSeconds(0, 0)

  for (let step = 0; step < NEXT_MATCH_HORIZON_MINUTES; step += 1) {
    if (matches(expression, cursor, timeZone)) return new Date(cursor)
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  return null
}

/**
 * De quanto em quanto tempo esta expressão roda, em milissegundos.
 *
 * Medida pelas duas próximas passadas, e não declarada: é o que permite ao painel de
 * saúde chamar um job de parado a partir de **três vezes** o intervalo dele (RN-12), sem
 * que cada job precise dizer o próprio período. `null` quando não há duas passadas no
 * horizonte — aí o painel não tem base para alarmar, e não alarma.
 */
export function intervalOf(expression: CronExpression, from: Date, timeZone: string): number | null {
  const first = nextMatch(expression, from, timeZone)
  if (!first) return null
  const second = nextMatch(expression, first, timeZone)
  if (!second) return null
  return second.getTime() - first.getTime()
}
