import { Writable } from 'node:stream'
import { pino, type Logger } from 'pino'
import { describe, expect, it } from 'vitest'
import { createLogger } from './logger.js'

/**
 * A suíte põe o logger em `silent`; aqui ele é remontado com as mesmas opções e um
 * destino em memória, para ler a linha que sairia em produção.
 */
function linhaDe(redact: readonly string[], escrever: (logger: Logger) => void) {
  const { loggerOptions } = createLogger({ service: 'teste', level: 'info', redact })
  const linhas: string[] = []
  const destino = new Writable({
    write(chunk, _encoding, done) {
      linhas.push(String(chunk))
      done()
    },
  })
  escrever(pino({ ...loggerOptions, level: 'info' }, destino))
  return JSON.parse(linhas[0] ?? '{}') as Record<string, Record<string, unknown>>
}

describe('createLogger — o erro no log', () => {
  const REDACT = ['*.message', '*.code', '*.name']

  it('a mensagem e o código do erro sobrevivem à redação de `*.message` e `*.code`', () => {
    const erro = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

    const linha = linhaDe(REDACT, (logger) => logger.error({ err: erro }, 'falhou'))

    expect(linha.err?.reason).toBe('Unique constraint failed')
    expect(linha.err?.errorCode).toBe('P2002')
    expect(linha.err?.type).toBe('Error')
  })

  it('o erro passado direto, sem objeto em volta, sai do mesmo jeito', () => {
    const linha = linhaDe(REDACT, (logger) => logger.error(new Error('sem conexão'), 'falhou'))

    expect(linha.err?.reason).toBe('sem conexão')
  })

  it('a redação continua valendo fora do erro', () => {
    const linha = linhaDe(REDACT, (logger) =>
      logger.info({ lead: { name: 'Ana', message: 'quanto custa o banho?' } }, 'lead'),
    )

    expect(linha.lead).toEqual({ name: '[redacted]', message: '[redacted]' })
  })

  it('`err` que não é erro passa como veio', () => {
    const linha = linhaDe(REDACT, (logger) => logger.warn({ err: 'timeout' }, 'falhou'))

    expect(linha.err).toBe('timeout')
  })
})
