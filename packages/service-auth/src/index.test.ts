import { describe, expect, it } from 'vitest'
import {
  SERVICE_HEADERS,
  SIGNATURE_MAX_AGE_MS,
  signServiceHeaders,
  verifyServiceHeaders,
  type ServiceAuthContext,
} from './index.js'

/** Contrato de confiança entre o gateway e os microserviços. */

const SECRET = 'segredo-de-teste-com-tamanho-suficiente'

const fullContext: ServiceAuthContext = {
  clerkUserId: 'user_123',
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  role: 'RECEPTIONIST',
  permissions: ['tutor:read', 'pet:read'],
  permVersion: 3,
}

describe('ida e volta', () => {
  it('assina e verifica o contexto completo', () => {
    const result = verifyServiceHeaders(signServiceHeaders(fullContext, SECRET), SECRET)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // As permissões voltam ordenadas: a normalização é o que torna a assinatura
    // reproduzível dos dois lados.
    expect(result.context).toEqual({ ...fullContext, permissions: ['pet:read', 'tutor:read'] })
  })

  it('assina e verifica o contexto mínimo, sem tenant', () => {
    // É o estado de quem acabou de se cadastrar e vai criar o primeiro tenant.
    const minimal: ServiceAuthContext = { clerkUserId: 'user_novo', permissions: [] }
    const result = verifyServiceHeaders(signServiceHeaders(minimal, SECRET), SECRET)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.tenantId).toBeUndefined()
    expect(result.context.permissions).toEqual([])
  })

  it('normaliza a ordem das permissões, para a assinatura ser reproduzível', () => {
    // Timestamp fixo: ele entra na assinatura, e sem fixá-lo o teste compararia
    // duas assinaturas de milissegundos diferentes.
    const now = 1_700_000_000_000
    const a = signServiceHeaders({ ...fullContext, permissions: ['pet:read', 'tutor:read'] }, SECRET, now)
    const b = signServiceHeaders({ ...fullContext, permissions: ['tutor:read', 'pet:read'] }, SECRET, now)
    expect(a[SERVICE_HEADERS.signature]).toBe(b[SERVICE_HEADERS.signature])
  })

  it('aceita header repetido lendo o primeiro valor', () => {
    const headers = signServiceHeaders(fullContext, SECRET)
    const withArray = { ...headers, [SERVICE_HEADERS.clerkUserId]: [headers[SERVICE_HEADERS.clerkUserId]!] }
    expect(verifyServiceHeaders(withArray, SECRET).ok).toBe(true)
  })
})

describe('rejeições', () => {
  it('recusa assinatura feita com outro segredo', () => {
    const result = verifyServiceHeaders(signServiceHeaders(fullContext, 'outro-segredo'), SECRET)
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('recusa headers sem assinatura', () => {
    const result = verifyServiceHeaders({ [SERVICE_HEADERS.clerkUserId]: 'user_123' }, SECRET)
    expect(result).toEqual({ ok: false, reason: 'MISSING_SIGNATURE' })
  })

  it('recusa assinatura fora da janela de validade', () => {
    const headers = signServiceHeaders(fullContext, SECRET, Date.now() - SIGNATURE_MAX_AGE_MS - 1000)
    const result = verifyServiceHeaders(headers, SECRET)
    expect(result).toEqual({ ok: false, reason: 'STALE_TIMESTAMP' })
  })

  it('recusa timestamp muito no futuro, contra relógio adulterado', () => {
    const headers = signServiceHeaders(fullContext, SECRET, Date.now() + SIGNATURE_MAX_AGE_MS + 1000)
    expect(verifyServiceHeaders(headers, SECRET)).toEqual({ ok: false, reason: 'STALE_TIMESTAMP' })
  })

  // O ponto todo da assinatura: cada campo do contexto está coberto por ela.
  it.each([
    [SERVICE_HEADERS.tenantId, '33333333-3333-4333-8333-333333333333'],
    [SERVICE_HEADERS.role, 'TENANT_ADMIN'],
    [SERVICE_HEADERS.permissions, 'tutor:delete,finance:refund'],
    [SERVICE_HEADERS.userId, '44444444-4444-4444-8444-444444444444'],
    [SERVICE_HEADERS.permVersion, '99'],
    [SERVICE_HEADERS.clerkUserId, 'user_outro'],
  ])('invalida a assinatura ao adulterar %s', (header, tampered) => {
    const headers = { ...signServiceHeaders(fullContext, SECRET), [header]: tampered }
    expect(verifyServiceHeaders(headers, SECRET)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('recusa escalada de privilégio por remoção de header', () => {
    const headers = signServiceHeaders(fullContext, SECRET)
    delete headers[SERVICE_HEADERS.role]
    expect(verifyServiceHeaders(headers, SECRET)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('recusa assinatura de tamanho inesperado sem estourar', () => {
    const headers = { ...signServiceHeaders(fullContext, SECRET), [SERVICE_HEADERS.signature]: 'ab' }
    expect(verifyServiceHeaders(headers, SECRET)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })
})
