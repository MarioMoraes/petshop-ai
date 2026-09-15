import { describe, expect, it } from 'vitest'
import { readOrgId } from '../../src/auth/org-claim.js'

/**
 * A Organization ativa nos dois formatos de token que chegam ao backend.
 *
 * O caso que importa é o segundo: o token de sessão padrão do Clerk (versão 2) guarda a
 * Organization em `o.id`. Quando o frontend não conseguia o token do template e caía
 * nele, o backend lia só `org_id` e recusava com 403 um usuário que tinha estabelecimento
 * ativo (2026-09-15).
 */
describe('readOrgId', () => {
  it('lê `org_id` do JWT template', () => {
    expect(readOrgId({ sub: 'user_1', org_id: 'org_abc' })).toBe('org_abc')
  })

  it('lê `o.id` do token de sessão padrão', () => {
    expect(readOrgId({ sub: 'user_1', v: 2, o: { id: 'org_abc', rol: 'admin', slg: 'pet' } })).toBe(
      'org_abc',
    )
  })

  it('prefere o template quando os dois vêm', () => {
    expect(readOrgId({ org_id: 'org_template', o: { id: 'org_padrao' } })).toBe('org_template')
  })

  it.each([
    ['sessão sem Organization ativa', { sub: 'user_1' }],
    // O template renderiza `{{org.id}}` como string vazia quando não há Organization.
    ['template sem Organization', { org_id: '' }],
    ['`o` sem id', { o: {} }],
    ['`o` que não é objeto', { o: 'org_abc' }],
  ])('%s é nula', (_caso, payload) => {
    expect(readOrgId(payload as Record<string, unknown>)).toBeNull()
  })
})
