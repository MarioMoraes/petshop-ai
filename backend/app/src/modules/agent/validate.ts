import { createParseInput } from '@petshop/service-kit'
import { validationError } from './errors.js'

/** Ponto único de validação de entrada, como nos demais módulos. */
export const parseInput = createParseInput(validationError)
