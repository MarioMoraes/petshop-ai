import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro do Taxi Dog (PRD taxi_dog_07 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que
 * fica aqui é o catálogo — quais códigos existem e que regra produz cada um.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_TAXI_003',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

export function notFound(detail = 'Corrida não encontrada'): AppError {
  return new AppError('ERR_TAXI_001', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_TAXI_003', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_TAXI_009', detail)
}

/**
 * Requisição sem a assinatura do gateway. Usa o código de identidade de propósito:
 * quem não se autenticou não chegou a tocar em nenhuma corrida.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/** RN-01: não existe corrida sem agendamento. */
export function orphanRide(
  detail = 'A corrida precisa estar vinculada a um agendamento',
): AppError {
  return new AppError('ERR_TAXI_002', detail)
}

/** AC-04 de MOD-TAXI-01: já existe corrida viva desta perna no agendamento. */
export function duplicateLeg(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TAXI_004', detail, undefined, extra)
}

/** AC-03 de MOD-TAXI-02: nem endereço informado, nem cadastrado no tutor. */
export function missingAddress(
  detail = 'Informe o endereço de coleta ou cadastre o endereço do tutor',
): AppError {
  return new AppError('ERR_TAXI_005', detail)
}

/**
 * AC-02 de MOD-TAXI-03: motorista fora da jornada, em folga ou inativo.
 *
 * O `extra` carrega `available[]` porque negar sem oferecer alternativa devolve a
 * recepção ao WhatsApp: quem está atribuindo precisa saber quem **pode** ir.
 */
export function driverUnavailable(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TAXI_006', detail, undefined, extra)
}

/** AC-03 de MOD-TAXI-03: a van encheu. `extra.suggestions` traz outras janelas. */
export function vanFull(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TAXI_007', detail, undefined, extra)
}

/** §6: transição que a máquina de estado não permite. */
export function invalidTransition(detail: string): AppError {
  return new AppError('ERR_TAXI_008', detail)
}

/** AC-02 de MOD-TAXI-05: o tenant não cadastrou o serviço de categoria TAXI. */
export function noTaxiService(
  detail = 'Cadastre o serviço de Taxi Dog no catálogo antes de oferecer leva-e-traz',
): AppError {
  return new AppError('ERR_TAXI_010', detail)
}

/** AC-02 de MOD-TAXI-06, com `block_outside_zones` ligado. */
export function outsideZones(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TAXI_011', detail, undefined, extra)
}

/** RN-17: duas zonas disputando exatamente o mesmo prefixo. */
export function overlappingZone(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TAXI_012', detail, undefined, extra)
}

/** Zona ou veículo com corrida futura: desative em vez de excluir. */
export function inUse(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_TAXI_013', detail, undefined, extra)
}

/** RN-22: o petshop sem van não vê campo morto — e a API recusa junto. */
export function taxiDisabled(
  detail = 'O Taxi Dog está desligado nas configurações deste estabelecimento',
): AppError {
  return new AppError('ERR_TAXI_014', detail)
}
