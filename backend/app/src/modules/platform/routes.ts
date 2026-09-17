import { hashEmail } from '@petshop/db'
import {
  ChangeTenantPlanSchema,
  GrantPlatformAdminSchema,
  PlatformAlertQuerySchema,
  PlatformAuditQuerySchema,
  PlatformMetricsQuerySchema,
  RequestSupportAccessSchema,
  TenantListQuerySchema,
} from '@petshop/shared-types'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { listAlerts } from './alerts.js'
import { listPlatformAuditLogs } from './audit.js'
import { notFound } from './errors.js'
import { requestSupportAccess } from './grants.js'
import { platformHealth } from './health.js'
import { changeTenantPlan } from './plans.js'
import {
  grantPlatformAdmin,
  listPlatformAdmins,
  revokePlatformAdmin,
} from './service.js'
import { queryMetrics } from './metrics.js'
import { listTenants, tenantUsage } from './tenants.js'
import { parseInput } from './validate.js'

const IdParamSchema = z.object({ id: z.uuid() })
const TenantParamSchema = z.object({ tenantId: z.uuid() })

/**
 * As rotas da plataforma (PRD observabilidade_admin_14 §5).
 *
 * **O prefixo `/platform/v1` tem resolução de sessão própria**, e é a mesma razão pela
 * qual `/portal/v1` tem a dele: o contexto não sai de um `membership`. Quem chega aqui
 * apresenta token **sem Organization** e tem linha viva em `platform_admins` — as duas
 * coisas, e o `app.ts` as confere antes do roteamento.
 *
 * **Nenhuma destas rotas toca dado de negócio de tenant.** Elas administram o próprio
 * papel de plataforma. O acesso ao dado do estabelecimento é o MOD-ADMIN-02, e depende de
 * autorização com prazo.
 */

/** Quem está agindo, para a trilha da plataforma. */
function actorOf(request: FastifyRequest) {
  const context = request.authContext
  if (!context?.userId) throw notFound()
  return {
    userId: context.userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  }
}

export const PLATFORM_PREFIX = '/platform/v1'

/**
 * A pergunta que o `app.ts` faz antes de resolver a sessão.
 *
 * Mora aqui, e não no host, pela mesma razão que `isPortalPath` mora em
 * `modules/portal/routes.ts`: quem sabe qual é o espaço de rotas de um módulo é o módulo.
 */
export function isPlatformPath(path: string): boolean {
  return path === PLATFORM_PREFIX || path.startsWith(`${PLATFORM_PREFIX}/`)
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A lista existe para que a concessão não seja cega: conceder sem ver quem já tem é
   * como o segundo administrador vira o quarto sem ninguém notar.
   */
  app.get('/platform/v1/admins', async () => ({ items: await listPlatformAdmins() }))

  app.post('/platform/v1/admins', async (request, reply) => {
    const input = parseInput(GrantPlatformAdminSchema, request.body)
    /**
     * A busca é por **hash**, nunca pelo texto do e-mail: `users.email_encrypted` é
     * cifrado e `email_hash` é o índice de busca do produto inteiro. Um `LIKE` sobre a
     * coluna cifrada não acharia ninguém, e decifrar a base para comparar seria pior.
     */
    const created = await grantPlatformAdmin(actorOf(request), hashEmail(input.email))
    return reply.status(201).send(created)
  })

  app.delete('/platform/v1/admins/:id', async (request, reply) => {
    const { id } = parseInput(IdParamSchema, request.params)
    await revokePlatformAdmin(actorOf(request), id)
    return reply.status(204).send()
  })

  /**
   * O painel de estabelecimentos (MOD-ADMIN-03).
   *
   * Responde **sem grant**, e é a fronteira do módulo: plano, status, datas e contagens são
   * informação sobre o estabelecimento, não sobre os clientes dele. A ficha de um tutor,
   * ainda que o painel diga que existe só um, continua atrás do MOD-ADMIN-02.
   */
  app.get('/platform/v1/tenants', async (request) => {
    const query = parseInput(TenantListQuerySchema, request.query ?? {})
    return listTenants(query)
  })

  /** As contagens de um estabelecimento (MOD-ADMIN-07). */
  /**
   * A troca de plano (fatia 2 da camada comercial). Sem grant: plano é dado comercial da
   * conta, como o status, e não dado de negócio do estabelecimento.
   */
  app.patch('/platform/v1/tenants/:tenantId/plan', async (request) => {
    const { tenantId } = parseInput(TenantParamSchema, request.params)
    const input = parseInput(ChangeTenantPlanSchema, request.body)
    return changeTenantPlan(actorOf(request), tenantId, input)
  })

  app.get('/platform/v1/tenants/:tenantId/usage', async (request) => {
    const { tenantId } = parseInput(TenantParamSchema, request.params)
    return tenantUsage(tenantId)
  })

  /**
   * A saúde da plataforma (MOD-ADMIN-04).
   *
   * **Sempre 200**, mesmo com dependência fora do ar: o estado vai no corpo, e uma linha
   * vermelha diz muito mais que um 503 numa tela cujo trabalho é justamente mostrar o que
   * quebrou.
   */
  app.get('/platform/v1/health', async () => platformHealth())

  /**
   * A série temporal (MOD-ADMIN-05, AC-02).
   *
   * O balde servido depende da janela pedida, e não do que está guardado: trinta dias em
   * baldes de cinco minutos seriam 8.640 pontos, que é uma lista e não um gráfico.
   */
  app.get('/platform/v1/metrics', async (request) => {
    const query = parseInput(PlatformMetricsQuerySchema, request.query ?? {})
    return queryMetrics(query)
  })

  /**
   * Os alertas (MOD-ADMIN-06).
   *
   * **Só leitura.** Não há rota para acender nem para apagar um alerta à mão: quem os
   * governa é a regra, avaliada pelo job, e um botão de "resolver" aqui faria o painel
   * discordar da condição que continua valendo.
   */
  app.get('/platform/v1/alerts', async (request) => {
    const query = parseInput(PlatformAlertQuerySchema, request.query ?? {})
    return { items: await listAlerts(query) }
  })

  /**
   * A trilha cross-tenant (MOD-ADMIN-08).
   *
   * A leitura registra a si mesma, com o filtro usado: quem vigia também é vigiado, e essa
   * é a única razão pela qual esta rota existe.
   */
  app.get('/platform/v1/audit-logs', async (request) => {
    const query = parseInput(PlatformAuditQuerySchema, request.query ?? {})
    return listPlatformAuditLogs(actorOf(request), query)
  })

  /**
   * O pedido de acesso a um estabelecimento (MOD-ADMIN-02, AC-01).
   *
   * Só pedir: nada é lido aqui. Quem concede é o administrador do petshop, em
   * `POST /v1/support-access/:id/approve`, e é ele quem define o prazo.
   */
  app.post('/platform/v1/tenants/:tenantId/support-access', async (request, reply) => {
    const { tenantId } = parseInput(TenantParamSchema, request.params)
    const input = parseInput(RequestSupportAccessSchema, request.body)
    const actor = actorOf(request)

    const created = await requestSupportAccess(actor, tenantId, input.reason)
    return reply.status(201).send(created)
  })
}
