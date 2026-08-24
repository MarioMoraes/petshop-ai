import { AppError } from '@petshop/shared-types'
import Fastify, { type FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { z, type ZodError } from 'zod'
import { registerErrorHandler, zodToFieldErrors } from './errors.js'

/**
 * O handler é o único ponto que traduz exceção em resposta. O que se testa aqui é o
 * contrato do PRD §5 — formato, código, e sobretudo o que **não** vaza.
 */

const logger = pino({ level: 'silent' })

function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError('ERR_PET_002', detail ?? fields[0]?.message ?? 'inválido', fields)
}

function notFound(detail = 'Pet não encontrado'): AppError {
  return new AppError('ERR_PET_001', detail)
}

describe('registerErrorHandler', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = Fastify()
    registerErrorHandler(app, {
      logger,
      validationError,
      notFound,
      branches: [
        (error) =>
          typeof error === 'object' && error !== null && 'code' in error &&
          (error as { code: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'
            ? new AppError('ERR_PET_007', 'Arquivo grande demais')
            : null,
      ],
    })
  })

  it('traduz AppError para problem+json com o status do catálogo', async () => {
    app.get('/erro', async () => {
      throw new AppError('ERR_PET_005', 'Pet tem vínculo ativo', undefined, { tutorId: 'abc' })
    })

    const response = await app.inject({ method: 'GET', url: '/erro' })

    expect(response.statusCode).toBe(409)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const body = response.json()
    expect(body.code).toBe('ERR_PET_005')
    expect(body.detail).toBe('Pet tem vínculo ativo')
    // `extra` vira campo de topo: é assim que o 409 carrega o que a UI precisa abrir.
    expect(body.tutorId).toBe('abc')
    expect(body.traceId).toBeTruthy()
  })

  it('traduz ZodError solto para o 422 do catálogo, com a lista de campos', async () => {
    app.get('/zod', async () => {
      z.object({ nome: z.string() }).parse({ nome: 42 })
    })

    const response = await app.inject({ method: 'GET', url: '/zod' })

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.code).toBe('ERR_PET_002')
    expect(body.errors[0].field).toBe('nome')
  })

  it('deixa um ramo do serviço traduzir erro de biblioteca', async () => {
    app.get('/upload', async () => {
      throw Object.assign(new Error('file too large'), { code: 'FST_REQ_FILE_TOO_LARGE' })
    })

    const response = await app.inject({ method: 'GET', url: '/upload' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PET_007')
  })

  it('erro não previsto vira 500 sem devolver a mensagem original', async () => {
    app.get('/boom', async () => {
      throw new Error('SELECT * FROM tutors WHERE cpf = 12345678900')
    })

    const response = await app.inject({ method: 'GET', url: '/boom' })

    expect(response.statusCode).toBe(500)
    const body = response.json()
    expect(body.code).toBe('ERR_INTERNAL')
    expect(response.body).not.toContain('SELECT')
    expect(response.body).not.toContain('12345678900')
  })

  it('rota inexistente usa o 404 do catálogo do serviço, não o do Fastify', async () => {
    const response = await app.inject({ method: 'GET', url: '/nao-existe' })

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json().code).toBe('ERR_PET_001')
  })
})

describe('zodToFieldErrors', () => {
  it('nomeia campo aninhado pelo caminho e a raiz por `(raiz)`', () => {
    const schema = z.object({ endereco: z.object({ cep: z.string() }) })
    const result = schema.safeParse({ endereco: { cep: 1 } })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(zodToFieldErrors(result.error)[0]?.field).toBe('endereco.cep')

    const raiz = z.string().safeParse(1)
    if (raiz.success) return
    expect(zodToFieldErrors(raiz.error)[0]?.field).toBe('(raiz)')
  })
})
