import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/**
 * Ponto único de validação de entrada. Toda rota valida com o schema de
 * `@petshop/shared-types` — o mesmo que o frontend usa — e a falha vira 422
 * `ERR_LEDGER_002` com a lista de campos, no formato do §5.
 */
export const parseInput = createParseInput(validationError)
