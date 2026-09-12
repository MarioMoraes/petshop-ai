'use server'

import { ApiError } from '@petshop/api-client'
import type { SwitchTenantResult } from '@petshop/shared-types'
import { serverApi } from './api'

/**
 * A troca de estabelecimento, do lado do servidor (MOD-IDENT-05).
 *
 * **Arquivo em `lib/`, e não numa rota**, pelo mesmo motivo de `pendencias-actions.ts`:
 * quem chama é o `TenantSwitcher`, que mora na moldura do Admin e não pertence a tela
 * nenhuma.
 *
 * A troca em si continua sendo do navegador — só o `setActive` do SDK do Clerk reescreve
 * o `org_id` do token. O que esta ação faz é o que só o servidor pode fazer: conferir o
 * vínculo antes da viagem e deixar a troca registrada na trilha do estabelecimento de
 * destino. Ela também devolve o `clerkOrgId`, que era o dado que o componente antes
 * tentava adivinhar na lista do SDK — e quando não achava, o clique não fazia nada.
 */

export type SwitchTenantOutcome =
  | { ok: true; data: SwitchTenantResult }
  | { ok: false; message: string }

export async function switchTenantAction(tenantId: string): Promise<SwitchTenantOutcome> {
  try {
    return { ok: true, data: await serverApi().switchTenant(tenantId) }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message }
    }
    return {
      ok: false,
      message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    }
  }
}
