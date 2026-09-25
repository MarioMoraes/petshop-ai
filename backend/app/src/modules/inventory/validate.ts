import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/** A falha de schema vira 422 `ERR_INV_002` com a lista de campos. */
export const parseInput = createParseInput(validationError)
