import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * O caminho real da verificação, que o resto da suíte dubla por `setTokenVerifier`.
 *
 * O que se mede aqui é **quantas vezes o processo vai à rede**, porque o `kid` sai do
 * header do JWT e quem escreve o header é quem chama. O `verifyToken` do Clerk é dublado:
 * o que interessa é qual chave chega a ele, e se chega.
 */

const verifyToken = vi.hoisted(() => vi.fn())
vi.mock('@clerk/backend', () => ({ verifyToken }))

const { cacheGet, cacheSet } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}))
vi.mock('../../src/shared/redis.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cacheGet,
  cacheSet,
}))

const { InvalidTokenError, resetJwksMemo, verifySessionToken } =
  await import('../../src/auth/clerk-token.js')

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwkDe = (kid: string) => ({ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' })

/** Um JWT com o `kid` pedido. A assinatura não importa: quem confere é o dublê. */
function tokenCom(kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')
  return `${header}.e30.assinatura`
}

const fetchMock = vi.fn()

beforeEach(() => {
  resetJwksMemo()
  cacheGet.mockReset().mockResolvedValue(null)
  cacheSet.mockReset().mockResolvedValue(undefined)
  verifyToken.mockReset().mockResolvedValue({ sub: 'user_1' })
  fetchMock
    .mockReset()
    .mockImplementation(async () => Response.json({ keys: [jwkDe('ins_atual')] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verifySessionToken — o JWKS', () => {
  it('verifica com a chave do conjunto, e o conjunto fica na memória do processo', async () => {
    await verifySessionToken(tokenCom('ins_atual'))
    await verifySessionToken(tokenCom('ins_atual'))
    await verifySessionToken(tokenCom('ins_atual'))

    // Uma ida ao Clerk para três tokens, mesmo com o Redis sem nada (o caso do Redis fora).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(verifyToken).toHaveBeenCalledTimes(3)
    expect(verifyToken.mock.calls[0]?.[1]).toHaveProperty('jwtKey')
  })

  it('`kid` inventado é recusado sem `secretKey`, e não vira uma ida à rede por token', async () => {
    await verifySessionToken(tokenCom('ins_atual'))
    fetchMock.mockClear()

    for (let i = 0; i < 50; i += 1) {
      await expect(verifySessionToken(tokenCom(`ins_falso_${i}`))).rejects.toBeInstanceOf(
        InvalidTokenError,
      )
    }

    // Uma releitura no minuto, por mais tokens que cheguem; nenhum chega ao Clerk.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(verifyToken).toHaveBeenCalledTimes(1)
  })

  it('a chave nova da rotação entra pela releitura', async () => {
    await verifySessionToken(tokenCom('ins_atual'))
    fetchMock.mockImplementation(async () =>
      Response.json({ keys: [jwkDe('ins_atual'), jwkDe('ins_nova')] }),
    )

    await expect(verifySessionToken(tokenCom('ins_nova'))).resolves.toMatchObject({
      clerkUserId: 'user_1',
    })
    expect(verifyToken.mock.calls[1]?.[1]).toHaveProperty('jwtKey')
  })

  it('com o Clerk fora, cai no `secretKey` — o processo continua de pé', async () => {
    fetchMock.mockImplementation(async () => new Response('fora', { status: 503 }))

    await verifySessionToken(tokenCom('ins_atual'))

    expect(verifyToken.mock.calls[0]?.[1]).toHaveProperty('secretKey')
  })
})
