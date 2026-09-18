import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/**
 * Ponto único de validação de entrada. A rota valida com o schema de
 * `@petshop/shared-types` — o mesmo que a tela usa — e a falha vira 422
 * `ERR_IMPORT_002` com a lista de campos.
 */
export const parseInput = createParseInput(validationError)
