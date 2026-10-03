import { describe, expect, it } from 'vitest'
import { createAuthFailureGuard } from '../../src/auth/auth-failures.js'

describe('createAuthFailureGuard', () => {
  function relogio(inicio = 0) {
    let agora = inicio
    return { now: () => agora, avancar: (ms: number) => (agora += ms) }
  }

  it('bloqueia ao atingir o teto e solta quando a janela vira', () => {
    const tempo = relogio()
    const guard = createAuthFailureGuard({ max: 3, windowMs: 60_000, now: tempo.now })

    guard.record('a')
    guard.record('a')
    expect(guard.isBlocked('a')).toBe(false)
    guard.record('a')
    expect(guard.isBlocked('a')).toBe(true)

    tempo.avancar(60_000)
    expect(guard.isBlocked('a')).toBe(false)
    guard.record('a')
    expect(guard.isBlocked('a')).toBe(false)
  })

  it('cada chave tem a sua janela', () => {
    const guard = createAuthFailureGuard({ max: 1, windowMs: 60_000 })

    guard.record('a')

    expect(guard.isBlocked('a')).toBe(true)
    expect(guard.isBlocked('b')).toBe(false)
  })

  it('uma varredura de chaves não enche a memória: sai a mais antiga', () => {
    const guard = createAuthFailureGuard({ max: 1, windowMs: 60_000, maxKeys: 2 })

    guard.record('a')
    guard.record('b')
    guard.record('c')

    expect(guard.isBlocked('a')).toBe(false)
    expect(guard.isBlocked('b')).toBe(true)
    expect(guard.isBlocked('c')).toBe(true)
  })
})
