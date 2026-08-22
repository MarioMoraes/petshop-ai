import { withTenant, type SecurityEventType } from '@petshop/db'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC). O tutor-service registra as negações de permissão
 * do PRD tutores_02 §9 e as tentativas de alcançar tutor de outro tenant.
 *
 * Escrita fora da transação da requisição, de propósito: a operação que disparou o
 * evento em geral está sendo rejeitada e vai dar rollback, mas o registro da tentativa
 * precisa sobreviver a essa rejeição.
 */

export interface SecurityEventInput {
  tenantId: string
  type: SecurityEventType
  actorUserId?: string | null
  targetEntity?: string | null
  targetId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await withTenant(input.tenantId, (tx) =>
      tx.securityEvent.create({
        data: {
          tenantId: input.tenantId,
          type: input.type,
          actorUserId: input.actorUserId ?? null,
          targetEntity: input.targetEntity ?? null,
          targetId: input.targetId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          metadata: (input.metadata ?? {}) as object,
        },
      }),
    )
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
    recordMetric({ metric: 'cross_tenant_attempt_total', tenantId: input.tenantId, value: 1, unit: 'count' })
  }

  if (input.type === 'PERMISSION_DENIED') {
    recordMetric({
      metric: 'auth_permission_denied_total',
      tenantId: input.tenantId,
      value: 1,
      unit: 'count',
    })
  }
}
