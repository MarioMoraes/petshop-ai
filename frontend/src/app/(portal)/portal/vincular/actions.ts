'use server'

import { PortalError, requestAccessCode, verifyAccessCode } from '@/lib/portal-api'

/**
 * Ações do vínculo do Portal (MOD-PORTAL-01).
 *
 * Rodam no servidor: o token do Clerk e o endereço do gateway nunca chegam ao browser.
 * Devolvem resultado discriminado em vez de lançar — o formulário precisa mostrar o
 * erro no campo certo, não uma tela de erro.
 */

export interface CodeRequested {
  ok: true
  challengeId: string
  maskedTarget: string
  channel: 'EMAIL' | 'WHATSAPP'
}

export interface ActionFailure {
  ok: false
  message: string
}

export async function pedirCodigo(
  identifier: string,
  honeypot: string,
): Promise<CodeRequested | ActionFailure> {
  try {
    const result = await requestAccessCode({ identifier, website: honeypot })
    return {
      ok: true,
      challengeId: result.challengeId,
      maskedTarget: result.maskedTarget,
      channel: result.channel,
    }
  } catch (error) {
    return failure(error, 'Não foi possível enviar o código agora. Tente de novo.')
  }
}

export async function confirmarCodigo(
  challengeId: string,
  code: string,
): Promise<{ ok: true } | ActionFailure> {
  try {
    await verifyAccessCode({ challengeId, code })
    return { ok: true }
  } catch (error) {
    return failure(error, 'Não foi possível confirmar o código. Tente de novo.')
  }
}

/**
 * A mensagem do serviço, quando ela é do catálogo do Portal.
 *
 * Os textos de `ERR_PORTAL_*` foram escritos para o cliente final — "fale com o
 * estabelecimento", e não "conflito de unicidade". Reescrevê-los aqui duplicaria a
 * decisão em dois lugares e faria um dos dois envelhecer.
 */
function failure(error: unknown, fallback: string): ActionFailure {
  if (error instanceof PortalError) return { ok: false, message: error.message }
  return { ok: false, message: fallback }
}
