import { documentRetentionUntil, formatDocumentNumber } from '@petshop/shared-types'
import { describe, expect, it } from 'vitest'
import { checksumOf } from './registry.js'

describe('a série do documento (MOD-DOC-03)', () => {
  it('o recibo mantém o formato que já está em produção, sem prefixo', () => {
    // AC-04: renumerar documento emitido é reescrever papel entregue.
    expect(formatDocumentNumber('RECEIPT', 2026, 123)).toBe('2026/000123')
  })

  it('os tipos novos ganham prefixo, para não colidirem entre si', () => {
    expect(formatDocumentNumber('PRESCRIPTION', 2026, 4)).toBe('RX-2026/000004')
    expect(formatDocumentNumber('TERM_ACCEPTANCE', 2026, 4)).toBe('TR-2026/000004')
    expect(formatDocumentNumber('IMAGE_CONSENT', 2026, 4)).toBe('IM-2026/000004')
  })

  it('o sequencial tem seis dígitos, e o milionésimo não trunca', () => {
    expect(formatDocumentNumber('RECEIPT', 2026, 1)).toBe('2026/000001')
    expect(formatDocumentNumber('RECEIPT', 2026, 1_000_000)).toBe('2026/1000000')
  })
})

describe('a guarda (RN-17)', () => {
  it('são cinco anos a partir da emissão', () => {
    const until = documentRetentionUntil(new Date('2026-03-10T00:00:00Z'))
    expect(until.toISOString().slice(0, 10)).toBe('2031-03-10')
  })

  it('não escorrega no 29 de fevereiro', () => {
    // 2028 é bissexto e 2033 não é: o `setUTCFullYear` resolve para 1º de março.
    const until = documentRetentionUntil(new Date('2028-02-29T00:00:00Z'))
    expect(until.toISOString().slice(0, 10)).toBe('2033-03-01')
  })
})

describe('o checksum', () => {
  it('é o SHA-256 do arquivo, e muda com um byte', () => {
    const a = checksumOf(Buffer.from('%PDF-1.4 a'))
    const b = checksumOf(Buffer.from('%PDF-1.4 b'))

    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
