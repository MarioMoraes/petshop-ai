'use server'

import type {
  PortalAddressInput,
  PortalContactChangeInput,
  PortalContactChangeResponse,
  PortalContactVerifyInput,
  PortalDeletionRequestInput,
  PortalMeDataResponse,
  UpdateOwnTutorInput,
  UpdatePortalAddressInput,
} from '@petshop/shared-types'
import {
  PortalError,
  addOwnAddress,
  requestContactChange,
  requestOwnDeletion,
  updateOwnAddress,
  updateOwnProfile,
  verifyContactChange,
} from '@/lib/portal-api'

/**
 * As ações de Meus Dados (MOD-PORTAL-09).
 *
 * Server Actions e não `fetch` do navegador, pela mesma razão do resto do Portal: o token
 * do Clerk e o endereço do gateway não saem do servidor.
 *
 * **Toda ação de escrita devolve a ficha inteira**, porque é isso que o BFF responde. A
 * tela troca o estado por essa resposta em vez de remendar o que tinha: um endereço que
 * parece salvo e não está é o defeito que uma tela de cadastro paga caro — a pessoa fecha
 * o navegador confiando no que leu.
 */

type Resultado<T> = ({ ok: true } & T) | { ok: false; message: string }

async function tentar<T>(acao: () => Promise<T>, queda: string): Promise<Resultado<T>> {
  try {
    return { ok: true, ...(await acao()) }
  } catch (error) {
    if (error instanceof PortalError) return { ok: false, message: error.message }
    return { ok: false, message: queda }
  }
}

export function salvarPerfil(
  input: UpdateOwnTutorInput,
): Promise<Resultado<PortalMeDataResponse>> {
  return tentar(() => updateOwnProfile(input), 'Não foi possível salvar agora.')
}

export function salvarEndereco(
  input: PortalAddressInput,
): Promise<Resultado<PortalMeDataResponse>> {
  return tentar(() => addOwnAddress(input), 'Não foi possível salvar o endereço agora.')
}

export function corrigirEndereco(
  addressId: string,
  input: UpdatePortalAddressInput,
): Promise<Resultado<PortalMeDataResponse>> {
  return tentar(
    () => updateOwnAddress(addressId, input),
    'Não foi possível salvar o endereço agora.',
  )
}

/** Pede o código. Ele sai para o contato **novo** — é o que a verificação prova. */
export function pedirCodigoContato(
  input: PortalContactChangeInput,
): Promise<Resultado<PortalContactChangeResponse>> {
  return tentar(() => requestContactChange(input), 'Não foi possível enviar o código agora.')
}

export function confirmarContato(
  input: PortalContactVerifyInput,
): Promise<Resultado<PortalMeDataResponse>> {
  return tentar(() => verifyContactChange(input), 'Não foi possível confirmar agora.')
}

export function pedirExclusao(
  input: PortalDeletionRequestInput,
): Promise<Resultado<PortalMeDataResponse>> {
  return tentar(() => requestOwnDeletion(input), 'Não foi possível registrar o pedido agora.')
}
