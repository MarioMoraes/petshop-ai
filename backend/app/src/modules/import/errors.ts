import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * O catálogo de erro do MOD-IMPORT.
 *
 * Curto de propósito. **O erro de uma linha não é um erro da requisição**: a planilha
 * com quarenta CPFs tortos responde 200, com as quarenta marcadas `ERRO` no relatório e
 * a razão de cada uma. O que sai daqui é o que impede a carga inteira de acontecer.
 *
 * O erro que vem de dentro de uma linha é do **módulo dono** e atravessa com o código
 * original — `ERR_TUTOR_004` de duplicata, `ERR_AGENDA_005` de profissional
 * indisponível. Traduzi-lo para um `ERR_IMPORT_*` faria a mesma falha ter dois nomes
 * conforme a porta por onde entrou, e a mensagem do módulo é melhor do que qualquer
 * coisa que este aqui saberia escrever.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_IMPORT_002',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Lote de importação não encontrado'): AppError {
  return new AppError('ERR_IMPORT_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_IMPORT_002', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_IMPORT_003', detail)
}

/** Requisição que chegou sem sessão. Usa o código de identidade, como os outros módulos. */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** Desfazer o que já foi desfeito, ou o que ganhou histórico depois da carga. */
export function notUndoable(detail: string): AppError {
  return new AppError('ERR_IMPORT_004', detail)
}
