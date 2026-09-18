import { describe, expect, it } from 'vitest'
import { missingRequired, readRow, suggestMapping, templateCsv } from './mapping.js'

/**
 * O farejador de colunas. Testes puros — é o que separa "importar" de "redigitar".
 */

describe('suggestMapping', () => {
  it('reconhece os cabeçalhos que o sistema antigo escreve', () => {
    const mapping = suggestMapping('TUTOR', ['Cliente', 'CPF', 'Celular', 'E-mail'])
    expect(mapping.fullName).toBe(0)
    expect(mapping.cpf).toBe(1)
    expect(mapping.phone).toBe(2)
    expect(mapping.email).toBe(3)
  })

  it('a igualdade exata vem antes do "contém"', () => {
    /**
     * Sem as duas passadas, `Nome do tutor` levaria o campo `Nome do pet` só por vir
     * antes na planilha — e quatrocentos pets entrariam chamados como os donos.
     */
    const mapping = suggestMapping('PET', ['Nome do tutor', 'Nome do pet', 'Espécie', 'Porte'])
    expect(mapping.name).toBe(1)
  })

  it('o tutor do pet é achado pelo documento ou pelo contato, nunca pelo nome', () => {
    /**
     * `Nome do tutor` fica **sem campo** de propósito: a resolução do dono é por CPF,
     * CNPJ ou celular, e casar por nome penduraria o pet da Maria na ficha da Mariana.
     * A tela mostra o obrigatório em falta, e o operador aponta a coluna certa.
     */
    const semDocumento = suggestMapping('PET', ['Nome do tutor', 'Nome do pet'])
    expect(semDocumento.tutorRef).toBeUndefined()

    const comDocumento = suggestMapping('PET', ['CPF do tutor', 'Nome do pet'])
    expect(comDocumento.tutorRef).toBe(0)
  })

  it('uma coluna nunca serve a dois campos', () => {
    const mapping = suggestMapping('TUTOR', ['Telefone'])
    const usados = Object.values(mapping)
    expect(new Set(usados).size).toBe(usados.length)
  })

  it('data e hora na mesma coluna: a hora divide a coluna da data', () => {
    // O caso real da agenda exportada num campo só. É a única exceção à regra acima.
    const mapping = suggestMapping('AGENDA', ['CPF', 'Pet', 'Profissional', 'Serviço', 'Data/Hora'])
    expect(mapping.date).toBe(4)
    expect(mapping.time).toBe(4)
  })

  it('uma coluna de data sem hora não é oferecida ao horário', () => {
    // Apontar o horário para uma coluna só de data faria TODA linha falhar.
    const mapping = suggestMapping('AGENDA', ['CPF', 'Pet', 'Profissional', 'Serviço', 'Data'])
    expect(mapping.date).toBe(4)
    expect(mapping.time).toBeUndefined()
  })
})

describe('missingRequired', () => {
  it('nomeia os obrigatórios que ninguém apontou', () => {
    const faltando = missingRequired('PET', suggestMapping('PET', ['Nome do pet']))
    expect(faltando).toContain('CPF ou celular do tutor')
    expect(faltando).toContain('Espécie')
    expect(faltando).not.toContain('Nome do pet')
  })

  it('mapeamento completo não deixa nada faltando', () => {
    const mapping = suggestMapping('PROFISSIONAL', ['Nome', 'Função'])
    expect(missingRequired('PROFISSIONAL', mapping)).toEqual([])
  })
})

describe('readRow', () => {
  it('separa payload, endereço, consentimento e chaves de resolução', () => {
    const headers = ['Nome', 'Celular', 'CEP', 'Cidade', 'Aceita WhatsApp']
    const mapping = suggestMapping('TUTOR', headers)
    const values = readRow('TUTOR', mapping, [
      'Ana Souza',
      '(11) 98888-7777',
      '01310-100',
      'São Paulo',
      'Sim',
    ])

    expect(values.payload.fullName).toBe('Ana Souza')
    expect(values.payload.phone).toBe('11988887777')
    expect(values.address).toMatchObject({ zipCode: '01310100', city: 'São Paulo' })
    expect(values.consent.whatsapp).toBe(true)
    expect(values.errors).toEqual([])
  })

  it('junta TODOS os erros da linha, e não só o primeiro', () => {
    /**
     * Parar no primeiro faria o operador corrigir uma coluna, subir de novo e descobrir
     * a segunda — um ciclo de quatrocentas linhas por vez.
     */
    const headers = ['Nome do pet', 'CPF', 'Espécie', 'Porte', 'Nascimento', 'Peso']
    const mapping = suggestMapping('PET', headers)
    const values = readRow('PET', mapping, ['Thor', '1', 'Cão', 'Grande', '31/02/2026', 'a pesar'])

    expect(values.errors).toHaveLength(2)
    expect(values.errors.join(' ')).toContain('Nascimento')
    expect(values.errors.join(' ')).toContain('Peso')
  })

  it('campo não mapeado simplesmente não aparece', () => {
    const values = readRow('TUTOR', { fullName: 0 }, ['Ana'])
    expect(values.payload).toEqual({ fullName: 'Ana' })
    expect(values.address).toBeNull()
  })
})

describe('templateCsv', () => {
  it('sai com separador `;` e cabeçalho limpo, para o Excel abrir em colunas', () => {
    const [cabecalho, exemplo] = templateCsv('TUTOR').split('\n')
    expect(cabecalho?.includes(';')).toBe(true)
    // Sem asterisco: um "Nome do tutor *" deixaria de casar com o próprio sinônimo
    // quando o arquivo preenchido voltasse.
    expect(cabecalho).not.toContain('*')
    expect(exemplo?.split(';').length).toBe(cabecalho?.split(';').length)
  })

  it('o modelo de cada passo se reconhece sozinho', () => {
    // O operador baixa, preenche e sobe de volta: se o modelo não casasse com o próprio
    // farejador, o passo mais simples da tela seria o que não funciona.
    for (const entity of ['TUTOR', 'PET', 'PROFISSIONAL', 'AGENDA'] as const) {
      const headers = (templateCsv(entity).split('\n')[0] as string).split(';')
      expect(missingRequired(entity, suggestMapping(entity, headers))).toEqual([])
    }
  })
})
