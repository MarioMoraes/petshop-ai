'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  ChangeTenantPlanSchema,
  GrantPlatformAdminSchema,
  RequestSupportAccessSchema,
  type PlatformAdminResponse,
  type SupportGrantResponse,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * As três escritas do console (MOD-ADMIN-01 e 02).
 *
 * O console é quase todo leitura, e isso não é acaso: a plataforma **observa** os
 * estabelecimentos e não opera dentro deles. As três exceções são sobre a própria equipe
 * — conceder e revogar o papel — e sobre pedir permissão a um tenant. Nenhuma delas toca
 * dado de negócio de ninguém.
 *
 * Não há ação para acender ou apagar alerta: quem os governa é a regra avaliada pelo job,
 * e um botão de "resolver" aqui faria o painel discordar da condição que continua valendo.
 * Também não há escrita na trilha — uma rota de escrita naquele módulo seria a porta pela
 * qual a prova deixa de ser prova.
 *
 * O resultado é discriminado em vez de lançar, como no Admin: o formulário precisa do erro
 * no campo, e não de uma tela de erro.
 */

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; message: string; fieldErrors: Record<string, string> }

function toFailure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    /**
     * **404 aqui não é "não encontrado", é a porta fechada.** Toda rota de `/platform/v1`
     * responde assim a quem não é da equipe ou está com um estabelecimento aberto no
     * Clerk, e a mensagem crua do backend ("Not Found") mandaria a pessoa procurar o
     * registro em vez de trocar de contexto.
     */
    if (error.status === 404) {
      return {
        ok: false,
        message:
          'A sessão da plataforma não está ativa. Volte para a sua conta pessoal e tente de novo.',
        fieldErrors: {},
      }
    }
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionResult<never> {
  const fieldErrors = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
  )
  return { ok: false, message: error.issues[0]?.message ?? 'Dados inválidos', fieldErrors }
}

/**
 * Pedir acesso à base de um estabelecimento (MOD-ADMIN-02, AC-01).
 *
 * Pedir é tudo o que a plataforma faz: quem concede é o administrador do petshop, na aba
 * Suporte das Configurações dele, e é ele quem escolhe o prazo. O motivo tem mínimo de dez
 * caracteres porque é o texto que essa pessoa vai ler para decidir — "suporte" não é
 * motivo, "chamado #482, tutor relata recibo não recebido" é.
 */
export async function pedirAcessoAction(
  tenantId: string,
  reason: string,
): Promise<ActionResult<SupportGrantResponse>> {
  const parsed = RequestSupportAccessSchema.safeParse({ reason })
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const grant = await serverApi().requestSupportAccess(tenantId, parsed.data.reason)
    revalidatePath('/plataforma/estabelecimentos')
    return { ok: true, data: grant }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Muda o plano de um estabelecimento (fatia 2 da camada comercial).
 *
 * A quarta escrita, e a primeira sobre o estabelecimento — mas sobre a **conta** dele, e
 * não sobre o que há dentro: plano é dado comercial, como o estado. O motivo tem o mesmo
 * mínimo do pedido de acesso, porque também é lido pelo administrador do petshop, na
 * trilha de auditoria dele.
 */
export async function mudarPlanoAction(
  tenantId: string,
  plan: string,
  reason: string,
): Promise<ActionResult<{ tenantId: string; plan: string }>> {
  const parsed = ChangeTenantPlanSchema.safeParse({ plan, reason })
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const result = await serverApi().changeTenantPlan(tenantId, parsed.data)
    revalidatePath('/plataforma/estabelecimentos')
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}

/** Concede o papel de plataforma a quem já acessou o produto ao menos uma vez (AC-04). */
export async function concederAction(email: string): Promise<ActionResult<PlatformAdminResponse>> {
  const parsed = GrantPlatformAdminSchema.safeParse({ email })
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const admin = await serverApi().grantPlatformAdmin(parsed.data.email)
    revalidatePath('/plataforma/equipe')
    return { ok: true, data: admin }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Revoga o papel (AC-05).
 *
 * O servidor recusa a revogação do **último** administrador ativo, e a guarda é a mesma do
 * último `TENANT_ADMIN`: uma plataforma sem administrador não tem como voltar a ter um —
 * conceder exige um administrador vivo, e a única saída seria o `psql`.
 */
export async function revogarAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().revokePlatformAdmin(id)
    revalidatePath('/plataforma/equipe')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
