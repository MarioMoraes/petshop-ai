import type { TenantTransaction } from '@petshop/db'
import { logger } from './logger.js'

/**
 * Trilha de auditoria (MOD-IDENT-09).
 *
 * A lista de ações que **devem** gerar registro está no PRD §9. A escrita acontece
 * dentro da mesma transação da operação auditada: ou os dois acontecem, ou nenhum —
 * uma trilha que perde registros quando a transação falha não serve de trilha.
 */

/** Chaves cujo valor nunca vai para `before`/`after` em claro. */
const SENSITIVE_KEYS = new Set([
  'email',
  'emailEncrypted',
  'emailHash',
  'phone',
  'phoneEncrypted',
  'cnpj',
  'cnpjEncrypted',
  'tokenHash',
  'encryptedDek',
  'password',
])

/** Substitui PII por marcador, preservando a forma do objeto para o diff. */
export function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : sanitize(item)
  }
  return result
}

export interface AuditEntry {
  tenantId?: string | null
  actorUserId?: string | null
  action: string
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  outcome?: 'ALLOWED' | 'DENIED'
  ipAddress?: string | null
  userAgent?: string | null
}

export async function recordAudit(tx: TenantTransaction, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: entry.tenantId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: entry.before === undefined ? undefined : (sanitize(entry.before) as object),
      after: entry.after === undefined ? undefined : (sanitize(entry.after) as object),
      outcome: entry.outcome ?? 'ALLOWED',
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    },
  })
  logger.debug({ action: entry.action, entity: entry.entity }, 'auditoria registrada')
}
