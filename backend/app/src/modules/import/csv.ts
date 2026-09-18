/**
 * O leitor de CSV — a porta de entrada do MOD-IMPORT. Funções **puras**, sem banco.
 *
 * Por que CSV e não `.xlsx`: todo sistema de petshop exporta CSV, e ler planilha
 * binária traria um parser de terceiros para dentro do backend só para poupar um
 * "Salvar como" ao operador.
 *
 * O trabalho aqui não é "separar por vírgula" — é sobreviver ao que o Excel brasileiro
 * produz. As três armadilhas, todas silenciosas:
 *
 * - **O separador é `;`**, não `,`: no Windows em pt-BR o Excel usa o separador de
 *   lista do sistema. Assumir vírgula devolve UMA coluna por linha, e a tela diz
 *   "nenhum campo reconhecido" sem explicar nada.
 * - **A codificação é windows-1252**, não UTF-8, em qualquer arquivo que passou por
 *   "CSV (separado por vírgulas)" no Excel. Decodificar como UTF-8 troca cada acento
 *   por `�` — e aí "José" e "Jos<?>" são pessoas diferentes na deduplicação, o que só
 *   aparece depois de a base estar carregada.
 * - **UTF-8 com BOM** (a opção "CSV UTF-8" do Excel novo) põe `U+FEFF` no começo: sem
 *   removê-lo, o PRIMEIRO cabeçalho nunca casa com nenhum sinônimo — e a coluna mais
 *   importante do arquivo, quase sempre o código ou o CPF, é justamente a que o
 *   mapeamento perde.
 *
 * Nada disso é declarado no arquivo. Por isso tudo é FAREJADO, e o resultado volta
 * junto (`encoding`, `delimiter`) para a tela poder mostrar o que foi decidido —
 * palpite silencioso é o que faz o operador desconfiar do total sem saber de onde
 * reclamar.
 */

export type CsvEncoding = 'utf-8' | 'windows-1252'

export interface ParsedCsv {
  /** Cabeçalhos na ordem do arquivo, já sem BOM e sem espaço nas pontas. */
  headers: string[]
  /**
   * Uma linha por registro, **por posição** (não por nome). Chavear por cabeçalho
   * perderia dados em arquivo com coluna repetida ou sem título — e sistema antigo
   * exporta as duas coisas. O mapeamento resolve por índice.
   *
   * Toda linha tem exatamente `headers.length` células: as curtas são completadas com
   * `''` e as longas truncadas, para o consumidor nunca receber `undefined` de um
   * índice válido.
   */
  rows: string[][]
  delimiter: string
  encoding: CsvEncoding
}

/** O arquivo não é um CSV utilizável — quem chamou decide o que fazer. */
export class InvalidCsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCsvError'
  }
}

/**
 * Bytes → texto, decidindo a codificação pelo próprio conteúdo.
 *
 * A ordem é UTF-8 primeiro **em modo fatal**: um arquivo windows-1252 com acento é
 * sequência inválida em UTF-8, então o erro é o próprio detector. O contrário não
 * funcionaria — todo byte é válido em windows-1252, então tentá-lo antes acertaria
 * sempre e estragaria os arquivos UTF-8.
 *
 * A queda final é `latin1`, que não depende de o ICU do Node estar completo. Ele difere
 * de windows-1252 apenas na faixa 0x80–0x9F (aspas e travessões tipográficos); nos
 * acentos do português — 0xC0–0xFF — os dois são idênticos, que é o que precisa estar
 * certo num cadastro de nomes.
 */
export function decodeCsv(bytes: Buffer): { text: string; encoding: CsvEncoding } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text: stripBom(text), encoding: 'utf-8' }
  } catch {
    try {
      return {
        text: stripBom(new TextDecoder('windows-1252').decode(bytes)),
        encoding: 'windows-1252',
      }
    } catch {
      return { text: stripBom(bytes.toString('latin1')), encoding: 'windows-1252' }
    }
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Qual caractere separa as colunas.
 *
 * Conta os candidatos na primeira linha não vazia **fora das aspas**: um nome como
 * `"Silva, João"` na primeira linha de dados faria a vírgula ganhar de um arquivo que
 * na verdade é separado por `;`.
 *
 * Empate cai em `,` (o CSV canônico). Nenhum candidato encontrado também devolve `,`: o
 * arquivo de uma coluna só é válido, e o erro real — "nenhuma coluna reconhecida" —
 * pertence ao mapeamento, que sabe nomear o que faltou.
 */
export function sniffDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? ''

  let best = ','
  let bestCount = 0
  for (const candidate of [';', ',', '\t', '|']) {
    const count = countOutsideQuotes(line, candidate)
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function countOutsideQuotes(line: string, target: string): number {
  let count = 0
  let quoted = false
  for (const char of line) {
    if (char === '"') quoted = !quoted
    else if (char === target && !quoted) count += 1
  }
  return count
}

/**
 * Arquivo inteiro → cabeçalhos + linhas.
 *
 * Máquina de estados, e não `split(delimiter)`: campo entre aspas pode conter o
 * separador, quebra de linha e aspas escapadas (`""`). Um `split` ingênuo parte
 * `"Rua das Flores, 123"` em duas colunas e desloca todas as seguintes — o número vira
 * bairro, o bairro vira cidade, e nada disso levanta erro.
 *
 * Linha totalmente vazia é descartada (arquivo do Excel termina com uma), mas linha com
 * células vazias é registro legítimo e passa.
 */
export function parseCsv(bytes: Buffer): ParsedCsv {
  const { text, encoding } = decodeCsv(bytes)
  if (text.trim() === '') throw new InvalidCsvError('O arquivo está vazio.')

  const delimiter = sniffDelimiter(text)
  const records = splitRecords(text, delimiter)
  if (records.length === 0) throw new InvalidCsvError('O arquivo está vazio.')

  const headers = (records[0] as string[]).map((header) => header.trim())
  if (headers.every((header) => header === '')) {
    throw new InvalidCsvError('A primeira linha do arquivo precisa ser o cabeçalho das colunas.')
  }

  const rows = records.slice(1).map((cells) => normalizeWidth(cells, headers.length))
  if (rows.length === 0) {
    throw new InvalidCsvError('O arquivo tem o cabeçalho, mas nenhuma linha de dados.')
  }

  return { headers, rows, delimiter, encoding }
}

/** Completa/trunca para o consumidor nunca receber `undefined` de um índice válido. */
function normalizeWidth(cells: string[], width: number): string[] {
  if (cells.length === width) return cells
  if (cells.length > width) return cells.slice(0, width)
  return [...cells, ...(Array(width - cells.length).fill('') as string[])]
}

function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false

  const endCell = (): void => {
    cells.push(cell.trim())
    cell = ''
  }
  const endRecord = (): void => {
    endCell()
    // O arquivo do Excel termina com uma linha vazia; e uma linha em branco no meio do
    // arquivo é ruído, não um registro sem nenhum campo preenchido.
    if (cells.some((value) => value !== '')) records.push(cells)
    cells = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string

    if (quoted) {
      if (char === '"') {
        // `""` dentro de aspas é uma aspa literal; uma aspa sozinha fecha.
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else cell += char
      continue
    }

    if (char === '"') quoted = true
    else if (char === delimiter) endCell()
    else if (char === '\n') endRecord()
    else if (char !== '\r') cell += char
  }

  // Última linha sem quebra no fim do arquivo.
  if (cell !== '' || cells.length > 0) endRecord()

  return records
}
