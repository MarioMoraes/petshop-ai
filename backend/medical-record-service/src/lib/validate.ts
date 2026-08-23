import type { ZodType } from 'zod'
import { validationError } from './errors.js'

/**
 * Ponto único de validação de entrada. Toda rota valida com o schema de
 * `@petshop/shared-types` — o mesmo que o frontend usa — e a falha vira 422
 * `ERR_PRONT_002` com a lista de campos, no formato do PRD prontuario_04 §5.
 */
export function parseInput<T>(schema: ZodType<T>, value: unknown, detail?: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validationError(parsed.error, detail)
  return parsed.data
}
