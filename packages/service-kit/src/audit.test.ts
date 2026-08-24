import { Prisma } from '@petshop/db'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createAudit } from './audit.js'

/**
 * `sanitize` é a última barreira antes de a PII entrar em `audit_logs`, que é
 * append-only: o que passa aqui ninguém apaga depois.
 */

const logger = pino({ level: 'silent' })

describe('sanitize', () => {
  const { sanitize } = createAudit({ logger })

  it('mascara PII mantendo a forma do objeto, para o diff continuar legível', () => {
    const result = sanitize({ name: 'Thor', cpf: '12345678900', phone: '+5511999999999' })

    expect(result).toEqual({ name: 'Thor', cpf: '[redacted]', phone: '[redacted]' })
  })

  it('desce em objeto aninhado e em array', () => {
    const result = sanitize({
      tutor: { fullName: 'Ana', email: 'ana@exemplo.com' },
      contatos: [{ phone: '+551199' }, { phone: '+551188' }],
    }) as Record<string, Record<string, unknown>>

    expect(result.tutor?.email).toBe('[redacted]')
    expect(result.tutor?.fullName).toBe('Ana')
    expect(result.contatos).toEqual([{ phone: '[redacted]' }, { phone: '[redacted]' }])
  })

  it('converte Date, Decimal e bigint — sem isso o Prisma recusa o create da trilha', () => {
    const result = sanitize({
      criadoEm: new Date('2026-08-24T12:00:00.000Z'),
      peso: new Prisma.Decimal('32.5'),
      total: 900n,
    })

    expect(result).toEqual({
      criadoEm: '2026-08-24T12:00:00.000Z',
      peso: 32.5,
      total: 900,
    })
  })

  it('preserva null e undefined, que o Prisma distingue', () => {
    expect(sanitize(null)).toBeNull()
    expect(sanitize(undefined)).toBeUndefined()
  })

  it('acrescenta as chaves do serviço às padrão, sem perder as padrão', () => {
    const { sanitize: comExtras } = createAudit({
      logger,
      sensitiveKeys: ['reaction', 'microchip'],
    })

    const result = comExtras({ reaction: 'anafilaxia', microchip: '981020', cpf: '123', name: 'Thor' })

    expect(result).toEqual({
      reaction: '[redacted]',
      microchip: '[redacted]',
      cpf: '[redacted]',
      name: 'Thor',
    })
  })

  it('as chaves do serviço não vazam para outro serviço', () => {
    createAudit({ logger, sensitiveKeys: ['reaction'] })

    // Esta instância nunca declarou `reaction`: cada `createAudit` tem o próprio Set.
    expect((sanitize({ reaction: 'anafilaxia' }) as Record<string, unknown>).reaction).toBe(
      'anafilaxia',
    )
  })
})
