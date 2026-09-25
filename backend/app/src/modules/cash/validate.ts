import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/** A falha de schema vira 422 `ERR_CASH_002` com a lista de campos. */
export const parseInput = createParseInput(validationError)
