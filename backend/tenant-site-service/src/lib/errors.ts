import { AppError, type FieldError } from '@petshop/shared-types'
import {
  registerErrorHandler as registerKitErrorHandler,
  zodToFieldErrors,
} from '@petshop/service-kit'
import type { FastifyInstance } from 'fastify'
import type { ZodError } from 'zod'
import { logger } from './logger.js'

/**
 * Catálogo de erro do site (PRD site_tenant_10 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`; o que
 * fica aqui é o catálogo — quais códigos existem e que regra produz cada um.
 *
 * **A superfície pública quase não usa este arquivo**, e isso é de propósito: para o
 * visitante anônimo só existem duas respostas, 404 e 429. Nem "o site existe mas está
 * despublicado", nem "este tenant está suspenso" — cada distinção a mais é informação
 * sobre a instalação entregue a quem não se identificou.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_SITE_005',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

/** A resposta única da superfície pública quando não há página a servir (RN-06). */
export function notFound(detail = 'Site não encontrado'): AppError {
  return new AppError('ERR_SITE_006', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_SITE_005', detail, fields)
}

export function forbidden(detail: string): AppError {
  return new AppError('ERR_SITE_008', detail)
}

/**
 * Requisição sem a assinatura do gateway. Usa o código de identidade de propósito:
 * quem não se autenticou não chegou a tocar em nada do site.
 */
export function unauthorized(detail = 'Credenciais inválidas'): AppError {
  return new AppError('ERR_IDENT_005', detail)
}

/**
 * AC-02 de MOD-SITE-01: publicação sem os dados mínimos.
 *
 * O `extra` carrega `missing[]` porque recusar sem dizer o que falta manda o admin
 * caçar o campo pelas telas — e o que falta são exatamente três coisas.
 */
export function missingPublishData(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError('ERR_SITE_001', detail, undefined, extra)
}

/** AC-03 de MOD-SITE-02: endereço incompleto ou CEP que o ViaCEP não conhece. */
export function invalidAddress(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_SITE_002', detail, fields)
}

/** AC-02 de MOD-SITE-04: a galeria cheia. */
export function galleryFull(detail: string): AppError {
  return new AppError('ERR_SITE_003', detail)
}

/** AC-03 de MOD-SITE-08: teto do formulário público, por IP. */
export function tooManySubmissions(
  detail = 'Muitos envios deste endereço. Tente novamente mais tarde.',
): AppError {
  return new AppError('ERR_SITE_004', detail)
}

export function photoNotFound(detail = 'Foto não encontrada'): AppError {
  return new AppError('ERR_SITE_009', detail)
}

export function leadNotFound(detail = 'Contato não encontrado'): AppError {
  return new AppError('ERR_SITE_010', detail)
}

/** §6: transição que a máquina de estado do lead não permite. */
export function invalidLeadTransition(detail: string): AppError {
  return new AppError('ERR_SITE_011', detail)
}

/** Falha do R2. O upload não deixa linha órfã: a gravação vem depois do put. */
export function storageUnavailable(
  detail = 'Não foi possível guardar a imagem. Tente novamente.',
): AppError {
  return new AppError('ERR_SITE_012', detail)
}

export function registerErrorHandler(app: FastifyInstance): void {
  registerKitErrorHandler(app, { logger, validationError, notFound })
}
