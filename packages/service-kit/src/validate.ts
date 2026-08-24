import type { AppError } from '@petshop/shared-types'
import type { ZodError, ZodType } from 'zod'

/**
 * Ponto único de validação de entrada.
 *
 * Toda rota valida com o schema de `@petshop/shared-types` — o mesmo que o frontend
 * usa — e qualquer falha vira o 422 do catálogo do serviço, com a lista de campos, no
 * formato que os PRDs §5 definem.
 */
export function createParseInput(
  validationError: (error: ZodError, detail?: string) => AppError,
) {
  return function parseInput<T>(schema: ZodType<T>, value: unknown, detail?: string): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw validationError(parsed.error, detail)
    return parsed.data
  }
}
