import { describe, expect, it } from 'vitest'
import { decodeCsv, InvalidCsvError, parseCsv, sniffDelimiter } from './csv.js'

/**
 * O leitor de CSV. Testes puros: nada aqui toca o banco, e tudo aqui decide se a base
 * do cliente chega inteira ou com um acento trocado em cada nome.
 */

describe('decodeCsv', () => {
  it('lê UTF-8 sem BOM', () => {
    const { text, encoding } = decodeCsv(Buffer.from('Nome;Raça\nThor;Pastor', 'utf8'))
    expect(encoding).toBe('utf-8')
    expect(text).toContain('Raça')
  })

  it('tira o BOM do "CSV UTF-8" do Excel — senão o primeiro cabeçalho nunca casa', () => {
    const { text } = decodeCsv(Buffer.from('﻿Nome;Raça\nThor;Pastor', 'utf8'))
    expect(text.startsWith('Nome')).toBe(true)
  })

  it('cai em windows-1252 quando o acento não é sequência válida em UTF-8', () => {
    // 0xE7 é "ç" em windows-1252 e byte inválido isolado em UTF-8.
    const bytes = Buffer.from([0x52, 0x61, 0xe7, 0x61]) // "Raça"
    const { text, encoding } = decodeCsv(bytes)
    expect(encoding).toBe('windows-1252')
    expect(text).toBe('Raça')
  })
})

describe('sniffDelimiter', () => {
  it('acha o ponto e vírgula do Excel em pt-BR', () => {
    expect(sniffDelimiter('Nome;CPF;Celular\nAna;1;2')).toBe(';')
  })

  it('acha a vírgula do CSV canônico', () => {
    expect(sniffDelimiter('Nome,CPF,Celular')).toBe(',')
  })

  it('não conta o separador que está dentro das aspas', () => {
    // Sem ignorar as aspas, a vírgula de "Silva, Ana" ganharia de um arquivo que é `;`.
    expect(sniffDelimiter('"Silva, Ana";"Souza, Maria";X')).toBe(';')
  })

  it('arquivo de uma coluna só devolve vírgula — o erro é do mapeamento, que sabe nomeá-lo', () => {
    expect(sniffDelimiter('Nome\nAna')).toBe(',')
  })
})

describe('parseCsv', () => {
  const csv = (text: string): Buffer => Buffer.from(text, 'utf8')

  it('separa cabeçalho e linhas', () => {
    const parsed = parseCsv(csv('Nome;Celular\nAna;11988887777\nBia;11977776666\n'))
    expect(parsed.headers).toEqual(['Nome', 'Celular'])
    expect(parsed.rows).toEqual([
      ['Ana', '11988887777'],
      ['Bia', '11977776666'],
    ])
  })

  it('respeita aspas com separador, quebra de linha e aspas escapadas dentro', () => {
    const parsed = parseCsv(csv('Nome;Obs\nAna;"Rua das Flores, 123\nfundos"\nBia;"diz ""oi"""'))
    expect(parsed.rows[0]).toEqual(['Ana', 'Rua das Flores, 123\nfundos'])
    expect(parsed.rows[1]).toEqual(['Bia', 'diz "oi"'])
  })

  it('completa a linha curta e trunca a longa — índice válido nunca devolve `undefined`', () => {
    const parsed = parseCsv(csv('A;B;C\n1;2\n1;2;3;4'))
    expect(parsed.rows[0]).toEqual(['1', '2', ''])
    expect(parsed.rows[1]).toEqual(['1', '2', '3'])
  })

  it('descarta a linha em branco do fim do arquivo do Excel', () => {
    const parsed = parseCsv(csv('A;B\n1;2\n;\n\n'))
    expect(parsed.rows).toEqual([['1', '2']])
  })

  it('linha com célula vazia é registro legítimo', () => {
    const parsed = parseCsv(csv('A;B\n1;\n'))
    expect(parsed.rows).toEqual([['1', '']])
  })

  it('recusa arquivo vazio, sem cabeçalho e sem linha de dados', () => {
    expect(() => parseCsv(csv(''))).toThrow(InvalidCsvError)
    expect(() => parseCsv(csv(';;\n'))).toThrow(InvalidCsvError)
    expect(() => parseCsv(csv('A;B\n'))).toThrow(/nenhuma linha de dados/)
  })
})
