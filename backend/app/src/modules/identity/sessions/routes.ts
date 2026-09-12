import { listUserMemberships, withTenant } from '@petshop/db'
import { type SwitchTenantResult } from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../../shared/audit.js'
import { conflict, forbidden } from '../errors.js'
import { ensureLocalUser } from '../users/service.js'
import { parseInput } from '../validate.js'

/**
 * MOD-IDENT-05 — a troca de estabelecimento.
 *
 * **Sem `requireTenantContext`.** É a única rota do módulo que fala de dois tenants ao
 * mesmo tempo, e o de origem não importa: quem trabalha em dois petshops troca de um
 * para o outro, e quem acabou de aceitar um convite troca de nenhum para um.
 *
 * A rota **não devolve token**, e o AC-01 do PRD diz que devolveria. Quem emite token é
 * o Clerk e quem reescreve o `org_id` da sessão é o `setActive` do SDK, no navegador —
 * um par de tokens nosso seria uma segunda identidade, com a expiração e a revogação do
 * Clerk deixando de valer. O que o backend faz é o que só ele pode fazer: conferir o
 * vínculo antes da troca e deixar a prova dela na trilha.
 */

const SwitchTenantSchema = z.object({ tenantId: z.uuid() })

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/sessions/switch-tenant', async (request): Promise<SwitchTenantResult> => {
    const { tenantId } = parseInput(SwitchTenantSchema, request.body)
    const user = await ensureLocalUser(request.auth.clerkUserId)

    const membership = (await listUserMemberships(user.id)).find(
      (candidate) => candidate.tenantId === tenantId && candidate.status === 'ACTIVE',
    )

    /**
     * AC-02 — **a mesma resposta para "não existe" e "não é seu"**.
     *
     * Distinguir os dois casos transformaria a rota num oráculo de ids de tenant: quem
     * quisesse saber se um estabelecimento existe bastaria pedir para trocar para ele.
     * Vínculo suspenso cai aqui também, e é o desfecho certo — o gateway recusaria a
     * sessão logo depois da troca, e a pessoa voltaria sem entender o motivo.
     */
    if (!membership) {
      throw forbidden('Você não tem acesso a este estabelecimento')
    }

    /**
     * A trilha vai para o estabelecimento **destino**.
     *
     * `session.tenant_switched` é uma das ações que o §9 do PRD exige registrar, e quem
     * precisa vê-la é quem administra a base em que a pessoa acabou de entrar. Registrar
     * na origem contaria a saída a quem já não tem nada a fiscalizar.
     */
    const clerkOrgId = await withTenant(
      tenantId,
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { clerkOrgId: true },
        })
        /**
         * Vínculo sem Organization do outro lado.
         *
         * `tenants.clerk_org_id` é nulo enquanto o provisionamento não termina, e fica
         * nulo para sempre num `PROVISIONING_FAILED`. Não há para onde o `setActive`
         * apontar, e um 403 aqui mentiria: o acesso existe, o estabelecimento é que não
         * terminou de nascer.
         */
        if (!tenant.clerkOrgId) {
          throw conflict('Este estabelecimento ainda está sendo preparado')
        }

        await recordAudit(tx, {
          tenantId,
          actorUserId: user.id,
          action: 'session.tenant_switched',
          entity: 'membership',
          entityId: user.id,
          after: { roleKey: membership.roleKey },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })

        return tenant.clerkOrgId
      },
      { userId: user.id },
    )

    return {
      tenantId,
      tenantSlug: membership.tenantSlug,
      tenantName: membership.tenantName,
      clerkOrgId,
    }
  })
}
