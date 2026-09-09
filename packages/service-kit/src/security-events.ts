import { getMaintenancePrisma, withTenant, type SecurityEventType } from '@petshop/db'
import type { Logger } from 'pino'
import type { BusinessMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC): negações de permissão dos PRDs §9 e tentativas de
 * alcançar recurso de outro tenant.
 *
 * Escrita fora da transação da requisição, de propósito: a operação que disparou o
 * evento em geral está sendo rejeitada e vai dar rollback, mas o registro da tentativa
 * precisa sobreviver a essa rejeição. Por isso `withTenant` aqui abre transação
 * própria, em vez de receber a que está em curso.
 */

export interface SecurityEventInput {
  /**
   * O estabelecimento a que o evento pertence, ou `null` quando não há nenhum.
   *
   * `null` não é ausência de dado: é o evento **da instalação**. Uma assinatura de
   * serviço forjada e uma consulta que escapou do `withTenant` acontecem antes de
   * existir tenant a atribuir, e são justamente os dois casos mais graves. A linha é
   * gravada por `app_maintenance`, fica invisível a todo tenant por RLS, e é a
   * plataforma quem a lê.
   */
  tenantId: string | null
  type: SecurityEventType
  actorUserId?: string | null
  targetEntity?: string | null
  targetId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
}

export interface SecurityEventsConfig {
  logger: Logger
  recordMetric: (metric: BusinessMetric) => void
}

export function createSecurityEvents(config: SecurityEventsConfig) {
  const { logger, recordMetric } = config

  return async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
    const data = {
      tenantId: input.tenantId,
      type: input.type,
      actorUserId: input.actorUserId ?? null,
      targetEntity: input.targetEntity ?? null,
      targetId: input.targetId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: (input.metadata ?? {}) as object,
    }

    try {
      // Sem tenant, a política de RLS recusaria a linha: `tenant_id = current_tenant_id()`
      // é falso para NULL. A escrita de plataforma passa por `app_maintenance`, que tem
      // BYPASSRLS — é o mesmo caminho dos jobs cross-tenant.
      if (input.tenantId === null) {
        await getMaintenancePrisma().securityEvent.create({ data })
      } else {
        await withTenant(input.tenantId, (tx) => tx.securityEvent.create({ data }))
      }
    } catch (error) {
      // Nunca deixar a falha do registro mascarar a negação que o originou.
      logger.error({ err: error, type: input.type }, 'Falha ao registrar evento de segurança')
    }

    if (input.type === 'CROSS_TENANT_ATTEMPT') {
      // Qualquer ocorrência gera alerta imediato ao Super Admin (MOD-IDENT §10).
      logger.error(
        {
          alert: 'CROSS_TENANT_ATTEMPT',
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          targetEntity: input.targetEntity,
          targetId: input.targetId,
        },
        'tentativa de acesso cross-tenant',
      )
      recordMetric({
        metric: 'cross_tenant_attempt_total',
        tenantId: input.tenantId ?? undefined,
        value: 1,
        unit: 'count',
      })
    }

    if (input.type === 'PERMISSION_DENIED') {
      recordMetric({
        metric: 'auth_permission_denied_total',
        tenantId: input.tenantId ?? undefined,
        value: 1,
        unit: 'count',
      })
    }
  }
}
