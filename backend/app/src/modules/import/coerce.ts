/**
 * Conversores de célula do CSV para o tipo do domínio — funções **puras**.
 *
 * A regra que atravessa o arquivo inteiro: **vazio e inválido são coisas diferentes.**
 * Célula vazia devolve `undefined` (campo não informado, e o schema do módulo dono
 * decide se isso é aceitável); célula com lixo **levanta `CoerceError`** e vira a
 * mensagem daquela linha no relatório.
 *
 * Tratar as duas igual é o erro caro aqui: um peso escrito "a pesar" viraria zero, o
 * pet entraria com 0 kg, e o porte — que decide preço e duração do banho — sairia do
 * lugar errado sem nada ter falhado.
 *
 * O que este arquivo **não** faz é validar: CPF com dígito errado, telefone com DDD
 * inexistente e UF que não existe passam por aqui e são recusados pelo schema do
 * módulo dono, que é o mesmo do formulário. Duplicar a regra daria duas mensagens
 * diferentes para o mesmo dado torto.
 */

export class CoerceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoerceError'
  }
}

/** Sem acento, sem caixa, sem espaço nas pontas — a forma de comparar rótulos. */
export function normalize(raw: string): string {
  return raw
    .normalize('NFD')
    // Tira os acentos que o NFD acabou de separar da letra. `\p{M}` é a categoria
    // Unicode das marcas combinantes — escrevê-la por faixa poria caracteres
    // invisíveis no meio do arquivo.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Texto, ou `undefined` quando a célula está vazia. */
export function toText(raw: string): string | undefined {
  const value = raw.trim()
  return value === '' ? undefined : value
}

/** Só os dígitos (CPF/CNPJ, CEP, microchip). A validação de DV é do schema do módulo. */
export function toDigits(raw: string): string | undefined {
  const value = raw.replace(/\D/g, '')
  return value === '' ? undefined : value
}

/**
 * Telefone como o arquivo o escreveu, limpo do que não é dígito.
 *
 * Não normaliza para E.164 aqui: quem faz isso é `PhoneBRSchema`, que também conhece a
 * tabela de DDD e o nono dígito do celular antigo. Uma segunda implementação
 * divergiria dela no primeiro número de oito dígitos.
 *
 * O que se faz é descartar os marcadores de "não tem" que base antiga guarda no lugar
 * do campo vazio — sem isso, `(  )` chegaria ao schema e reprovaria a linha INTEIRA por
 * um campo que ninguém preencheu.
 */
export function toPhone(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, '')
  if (digits === '' || /^0+$/.test(digits)) return undefined
  return digits
}

/**
 * E-mail em minúsculas, ou `undefined`.
 *
 * Não valida o formato — quem valida é o schema do módulo dono. O que se faz aqui é
 * descartar os marcadores de "não tem": sem isso, `nao tem@x` chegaria ao schema e
 * reprovaria a linha inteira por um campo que ninguém preencheu.
 */
export function toEmail(raw: string): string | undefined {
  const value = raw.trim().toLowerCase()
  if (value === '' || ['-', '--', 'n/a', 'na', 'nao tem', 'não tem', 'sem email'].includes(value)) {
    return undefined
  }
  return value
}

/** UF em duas letras maiúsculas. A existência da sigla é conferida pelo schema. */
export function toUf(raw: string): string | undefined {
  const value = raw.trim().toUpperCase()
  if (value === '') return undefined
  if (!/^[A-Z]{2}$/.test(value)) throw new CoerceError(`"${raw.trim()}" não é uma UF`)
  return value
}

/**
 * Data → `YYYY-MM-DD`.
 *
 * Aceita `31/12/2026`, `31-12-2026`, `31.12.2026`, `2026-12-31` e `2026/12/31`.
 *
 * **Ano de dois dígitos** (`31/12/26`) existe em base antiga, e o corte NÃO é o do
 * POSIX (69/70): é `ano corrente + 10`. O corte fixo leria `45` como 2045, e o campo de
 * dois dígitos mais comum num cadastro de petshop é a data de nascimento — um cão
 * nascido em 1945 viraria um cão que nasce em 2045, que passa por qualquer validação e
 * só aparece quando alguém estranha a idade na ficha.
 *
 * O ano de referência é PARÂMETRO (com o relógio como padrão) para a função continuar
 * pura e o teste não mudar de resultado em 1º de janeiro.
 *
 * A data é conferida por reconstrução, e não por regex: `31/02/2026` casa com qualquer
 * padrão de dd/mm/aaaa e não existe. Aceitá-la poria um agendamento no dia 3 de março
 * sem ninguém pedir.
 */
export function toDate(raw: string, refYear = new Date().getUTCFullYear()): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined

  // Corta a hora ("31/12/2026 14:30"), que exportação de banco costuma trazer junto.
  const parts = (value.split(/\s/)[0] as string).split(/[/.-]/)
  if (parts.length !== 3) throw new CoerceError(`"${value}" não é uma data`)

  const [first, second, third] = parts as [string, string, string]

  let year: number
  let month: number
  let day: number

  // ISO quando o primeiro campo tem 4 dígitos; senão dd/mm/aaaa.
  if (first.length === 4) {
    year = Number(first)
    month = Number(second)
    day = Number(third)
  } else {
    day = Number(first)
    month = Number(second)
    year = Number(third)
    if (third.length <= 2) year = year <= (refYear + 10) % 100 ? 2000 + year : 1900 + year
  }

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new CoerceError(`"${value}" não é uma data`)
  }

  const reconstructed = new Date(Date.UTC(year, month - 1, day))
  if (
    reconstructed.getUTCFullYear() !== year ||
    reconstructed.getUTCMonth() !== month - 1 ||
    reconstructed.getUTCDate() !== day
  ) {
    throw new CoerceError(`"${value}" não é uma data que exista`)
  }

  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * Hora do dia → `HH:MM`.
 *
 * Aceita `14:30`, `14h30`, `1430`, `14` e `14:30:00`. Aceita também a data inteira com
 * hora (`31/12/2026 14:30`), porque o caso mais comum de exportação de agenda é uma
 * coluna só com os dois — e aí a MESMA coluna é mapeada em data e em hora.
 *
 * **Não devolve instante.** Hora de parede não vira UTC sem saber o fuso do
 * estabelecimento, e o fuso é leitura de banco: a conversão mora no serviço.
 */
export function toTimeOfDay(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined

  // Quando vem data e hora na mesma célula, a hora é o que sobra depois do espaço.
  const candidate = value.includes(' ') ? (value.split(/\s+/).pop() as string) : value

  const separated = /^(\d{1,2})[:h.](\d{2})(?::(\d{2}))?$/.exec(candidate)
  if (separated) return clockOf(Number(separated[1]), Number(separated[2]), candidate)

  const compact = /^(\d{2})(\d{2})$/.exec(candidate)
  if (compact) return clockOf(Number(compact[1]), Number(compact[2]), candidate)

  const hourOnly = /^(\d{1,2})h?$/.exec(candidate)
  if (hourOnly) return clockOf(Number(hourOnly[1]), 0, candidate)

  throw new CoerceError(`"${value}" não é um horário (use HH:MM)`)
}

function clockOf(hour: number, minute: number, raw: string): string {
  if (hour > 23 || minute > 59) throw new CoerceError(`"${raw}" não é um horário que exista`)
  return `${pad(hour)}:${pad(minute)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Sim/não → booleano.
 *
 * A lista é larga porque cada sistema escreve o seu: `S`, `Sim`, `1`, `X` (planilha
 * marcada com xis), `true`, `V` de verdadeiro.
 *
 * Célula vazia é `undefined`, e não `false`: num campo como "castrado" a diferença
 * entre "o tutor disse que não" e "ninguém perguntou" é clínica, e é o schema do módulo
 * dono que aplica o padrão.
 */
export function toBool(raw: string): boolean | undefined {
  const value = normalize(raw)
  if (value === '') return undefined
  if (['s', 'sim', '1', 'x', 'true', 't', 'v', 'verdadeiro', 'y', 'yes'].includes(value))
    return true
  if (['n', 'nao', '0', 'false', 'f', 'falso', 'no'].includes(value)) return false
  throw new CoerceError(`"${raw.trim()}" não é sim/não`)
}

export function toInt(raw: string): number | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  const digits = value.replace(/[^\d-]/g, '')
  if (digits === '' || !/^-?\d+$/.test(digits)) throw new CoerceError(`"${value}" não é um número`)
  return Number(digits)
}

/**
 * Número com decimais — o peso do pet (`12`, `12,5`, `12.5`, `12,5 kg`).
 *
 * O nó é decidir qual separador é o decimal, e a resposta é a mesma de toda exportação
 * brasileira: se há vírgula, ela é o decimal; o ponto sozinho também é, porque peso não
 * tem separador de milhar — nenhum pet pesa mil quilos.
 */
export function toDecimal(raw: string): number | undefined {
  const value = raw.trim()
  if (value === '') return undefined

  const cleaned = value.replace(/[^\d.,-]/g, '')
  if (cleaned === '' || !/\d/.test(cleaned)) throw new CoerceError(`"${value}" não é um número`)

  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned

  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) throw new CoerceError(`"${value}" não é um número`)
  return parsed
}

/**
 * Idade → meses.
 *
 * Aceita `3` (anos, que é como toda ficha de petshop escreve), `3 anos`, `8 meses`,
 * `1 ano e 6 meses` e `2a 3m`.
 *
 * **O número seco é lido como ANOS**, e essa escolha tem consequência: `8` vira 96
 * meses, não 8. É o que a coluna "Idade" de uma planilha de petshop quer dizer em
 * praticamente todos os casos, e a unidade explícita ("8 meses") continua disponível
 * para o filhote. Ler como meses erraria por doze vezes na maioria das linhas.
 */
export function toAgeMonths(raw: string): number | undefined {
  const value = normalize(raw)
  if (value === '') return undefined

  const years = /(\d+)\s*(?:a(?:no|nos)?)\b/.exec(value)
  const months = /(\d+)\s*(?:m(?:es|eses|ses)?)\b/.exec(value)

  if (years || months) {
    const total = Number(years?.[1] ?? 0) * 12 + Number(months?.[1] ?? 0)
    if (total === 0) throw new CoerceError(`"${raw.trim()}" não é uma idade`)
    return capAge(total, raw)
  }

  const bare = /^\d+([.,]\d+)?$/.exec(value)
  if (!bare) throw new CoerceError(`"${raw.trim()}" não é uma idade (use "3 anos" ou "8 meses")`)

  return capAge(Math.round(Number(value.replace(',', '.')) * 12), raw)
}

/** O teto é o do `CreatePetSchema` (360 meses). Falhar aqui nomeia a coluna. */
function capAge(months: number, raw: string): number {
  if (months > 360) throw new CoerceError(`"${raw.trim()}" é uma idade fora do possível`)
  return months
}

/**
 * Célula → um dos valores que o domínio aceita, por dicionário de sinônimos.
 *
 * O dicionário é `{ valor_do_dominio: [como o sistema antigo escreve] }`. Valor não
 * reconhecido **levanta**, com a lista do que é aceito: mapear para o primeiro da lista
 * faria "Fêmea" virar "Macho" em silêncio.
 */
export function toEnum<T extends string>(
  raw: string,
  synonyms: Record<T, readonly string[]>,
): T | undefined {
  const value = normalize(raw)
  if (value === '') return undefined

  for (const [domain, aliases] of Object.entries(synonyms) as [T, readonly string[]][]) {
    if (normalize(domain) === value) return domain
    if (aliases.some((alias) => normalize(alias) === value)) return domain
  }

  throw new CoerceError(
    `"${raw.trim()}" não é um valor conhecido (aceitos: ${Object.keys(synonyms).join(', ')})`,
  )
}

/**
 * Uma célula com vários valores → lista.
 *
 * Existe porque o que é N:N no nosso modelo vem numa coluna só na exportação: os
 * serviços que um profissional executa (`Banho/Tosa`), os serviços de um agendamento
 * (`Banho + Tosa higiênica`). Os separadores aceitos são `/ , ; +` e a barra invertida.
 *
 * O `+` na lista é o que obriga a escrever `Tosa higiênica` sem ele — e é um preço
 * baixo: nome de serviço com `+` no meio é raro, e a coluna de vários valores é comum.
 */
export function toList(raw: string): string[] | undefined {
  const value = raw.trim()
  if (value === '') return undefined

  const pieces = value
    .split(/[/,;+\\|]/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')

  return pieces.length > 0 ? pieces : undefined
}
