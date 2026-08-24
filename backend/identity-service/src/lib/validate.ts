import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/**
 * Ponto único de validação de entrada.
 *
 * Toda rota valida com o schema de `@petshop/shared-types` — o mesmo que o frontend
 * usa — e qualquer falha vira 422 `ERR_IDENT_002` com a lista de campos, no formato
 * que o PRD §5 define.
 */
export const parseInput = createParseInput(validationError)
