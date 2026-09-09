import { AppError, type FieldError } from '@petshop/shared-types'
import { zodToFieldErrors } from '@petshop/service-kit'
import type { ZodError } from 'zod'

/**
 * Catálogo de erro do Portal (PRD portal_tutor_09 §5).
 *
 * A tradução para `application/problem+json` mora em `@petshop/service-kit`, e o handler é
 * **um só, do processo** (`shared/errors.ts`). O que fica aqui é o catálogo — quais códigos
 * existem e que regra produz cada um.
 *
 * **A escolha que atravessa este arquivo é 404 no lugar de 403** (RN-03). Recurso que
 * existe para outro tutor responde "não encontrado", porque 403 confirma existência e
 * transformaria a superfície do cliente num enumerador da base do petshop. Vale para
 * todo `_own` do sistema, e não só para as rotas deste serviço.
 */

export function validationError(error: ZodError, detail?: string): AppError {
  const fields = zodToFieldErrors(error)
  return new AppError(
    'ERR_PORTAL_007',
    detail ?? fields[0]?.message ?? 'Dados de entrada inválidos',
    fields,
  )
}

/** A resposta única para o que não é deste tutor — exista ou não (RN-03). */
export function notFound(detail = 'Não encontrado'): AppError {
  return new AppError('ERR_PORTAL_001', detail)
}

/** AC-03 de MOD-PORTAL-01: código errado, expirado ou de desafio já consumido. */
export function invalidCode(detail = 'Código inválido ou expirado'): AppError {
  return new AppError('ERR_PORTAL_002', detail)
}

/**
 * AC-04 de MOD-PORTAL-01: a ficha já tem dono.
 *
 * A mensagem **não diz para qual conta**. Dizer confirmaria a existência daquela conta a
 * quem está justamente tentando descobri-la.
 */
export function alreadyLinked(
  detail = 'Esta ficha já tem acesso ao Portal. Fale com o estabelecimento.',
): AppError {
  return new AppError('ERR_PORTAL_003', detail)
}

/** AC-01 de MOD-PORTAL-11 e AC-05 de MOD-PORTAL-01. */
export function tooManyAttempts(
  detail = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
): AppError {
  return new AppError('ERR_PORTAL_004', detail)
}

/**
 * AC-06 de MOD-PORTAL-01: o mesmo telefone em duas fichas.
 *
 * Marido e esposa no mesmo celular é caso comum, e o MOD-TUTOR permite quando a recepção
 * confirma que são pessoas diferentes. Escolher uma das duas por conta própria daria a
 * um deles o extrato financeiro do outro.
 */
export function ambiguousIdentifier(
  detail = 'Encontramos mais de um cadastro com este contato. Fale com o estabelecimento.',
): AppError {
  return new AppError('ERR_PORTAL_005', detail)
}

/** AC-05 de MOD-PORTAL-02: vínculo revogado, ou requisição sem a assinatura do gateway. */
export function unauthorized(detail = 'Seu acesso ao Portal não está mais ativo'): AppError {
  return new AppError('ERR_PORTAL_006', detail)
}

export function invalid(detail: string, fields?: FieldError[]): AppError {
  return new AppError('ERR_PORTAL_007', detail, fields)
}

/** RN-15: o Portal ou o agendamento online desligados neste estabelecimento. */
export function forbidden(detail: string): AppError {
  return new AppError('ERR_PORTAL_008', detail)
}

/** §6 dos módulos de domínio: operação que o estado atual não permite. */
export function invalidState(detail: string): AppError {
  return new AppError('ERR_PORTAL_009', detail)
}

/**
 * Dependência de fora fora do ar.
 *
 * **Sobrou um emissor depois da fatia 11, e ele não é um salto HTTP.** Enquanto o Portal
 * era outro processo, este era o erro das cinco portas: scheduling, taxi, ledger, tutor e
 * messaging respondiam por rede, e rede cai. Hoje as cinco são chamada de função, e o
 * `AppError` do módulo de domínio sobe direto — o que restou é o Gotenberg, que continua
 * sendo outro contêiner (`me-export.ts`).
 *
 * O código também é emitido pelo **frontend**, em `lib/portal-api.ts`, quando o Next não
 * alcança o backend. Aposentá-lo aqui não o aposentaria de lá.
 */
export function upstreamUnavailable(
  detail = 'Não foi possível concluir agora. Tente novamente em instantes.',
): AppError {
  return new AppError('ERR_PORTAL_010', detail)
}

/**
 * AC-02 de MOD-PORTAL-09: o contato novo já é de outra ficha deste petshop.
 *
 * A mensagem **não diz de quem**, nem confirma que a outra ficha existe. Confirmar
 * devolveria ao Portal o poder de oráculo que o RN-04 tirou dele na porta de entrada — e
 * desta vez consultável em lote, por quem já tem sessão válida.
 */
export function contactInUse(
  detail = 'Este contato já está em uso em outro cadastro. Fale com o estabelecimento.',
): AppError {
  return new AppError('ERR_PORTAL_012', detail)
}

/**
 * Erro do próprio Fastify, antes de qualquer handler: corpo vazio com
 * `content-type: application/json`, JSON malformado, corpo grande demais.
 *
 * **Sem esta tradução eles viram 500.** O handler do `service-kit` só reconhece `AppError`
 * e `ZodError`; o resto cai no ramo final e responde "erro interno" — o que transforma
 * requisição malformada em alarme de bug nosso, com stack no log de erro.
 *
 * Nasceu no Portal porque era a superfície que recebia requisição de fora, e o comentário
 * de origem dizia que as rotas `/v1` do Admin só eram alcançadas pelo gateway. Com um
 * processo só isso deixou de separar alguém: o ramo entra em `MODULE_BRANCHES` de
 * `shared/errors.ts` e a tradução vale para todas as superfícies. O código emitido continua
 * sendo `ERR_PORTAL_007`, que é o 422 deste catálogo — trocá-lo pelo do host mudaria a
 * resposta que o frontend do Portal já lê.
 */
export function fastifyClientError(error: unknown): AppError | null {
  if (typeof error !== 'object' || error === null) return null

  const candidato = error as { statusCode?: unknown; code?: unknown; message?: unknown }
  const status = typeof candidato.statusCode === 'number' ? candidato.statusCode : 0
  const code = typeof candidato.code === 'string' ? candidato.code : ''

  if (status < 400 || status >= 500 || !code.startsWith('FST_')) return null

  return invalid(
    typeof candidato.message === 'string' ? candidato.message : 'Requisição malformada',
  )
}

