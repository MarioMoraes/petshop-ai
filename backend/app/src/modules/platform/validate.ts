import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/**
 * Ponto único de validação de entrada. A falha vira 422 `ERR_ADMIN_005` com a lista de
 * campos, no formato do §5.
 */
export const parseInput = createParseInput(validationError)
