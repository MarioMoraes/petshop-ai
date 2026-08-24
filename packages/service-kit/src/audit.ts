import { Prisma, type TenantTransaction } from '@petshop/db'
import type { Logger } from 'pino'

/**
 * Trilha de auditoria (PRDs §9).
 *
 * A escrita acontece dentro da mesma transação da operação auditada: ou os dois
 * acontecem, ou nenhum — uma trilha que perde registros quando a transação falha não
 * serve de trilha. É por isso que `recordAudit` recebe a transação, e não a abre.
 */

/**
 * Chaves cujo valor nunca vai para `before`/`after` em claro.
 *
 * A lista é a **união** do que os serviços tratam como sensível, e não a interseção,
 * porque o custo do erro é assimétrico: redigir a mais deixa a trilha menos rica;
 * redigir a menos grava PII em tabela imutável, que ninguém pode apagar depois.
 */
export const DEFAULT_SENSITIVE_KEYS = [
  'email',
  'emailEncrypted',
  'emailHash',
  'phone',
  'phoneAlt',
  'phoneEncrypted',
  'phoneAltEncrypted',
  'phoneHash',
  'phoneAltHash',
  'cpf',
  'cpfEncrypted',
  'cpfHash',
  'cnpj',
  'cnpjEncrypted',
  'cnpjHash',
  'street',
  'streetEncrypted',
  'number',
  'numberEncrypted',
  'complement',
  'complementEncrypted',
  'notes',
  'notesEncrypted',
  'birthDate',
  'tokenHash',
  'encryptedDek',
  'password',
] as const

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

export interface AuditConfig {
  logger: Logger
  /**
   * Chaves sensíveis **deste** serviço, somadas às padrão. É onde o
   * medical-record-service acrescenta `reaction` e `instructions`, e o pet-service o
   * `microchip`: campos que só existem no domínio de quem os declara.
   */
  sensitiveKeys?: readonly string[]
}

export interface ServiceAudit {
  sanitize: (value: unknown) => unknown
  recordAudit: (tx: TenantTransaction, entry: AuditEntry) => Promise<void>
}

export function createAudit(config: AuditConfig): ServiceAudit {
  const { logger } = config
  const sensitive = new Set<string>([...DEFAULT_SENSITIVE_KEYS, ...(config.sensitiveKeys ?? [])])

  /**
   * Substitui PII por marcador, preservando a forma do objeto para o diff.
   *
   * Os PRDs §9 pedem o diff com "PII mascarada": o que interessa na trilha é *que* o
   * campo mudou e quem mudou, nunca o valor em si — para lê-lo há o endpoint
   * dedicado, com auditoria própria.
   */
  function sanitize(value: unknown): unknown {
    if (value === null || value === undefined) return value
    if (value instanceof Date) return value.toISOString()
    // `Decimal` e `bigint` chegam aqui vindos direto da linha do banco. Sem converter,
    // o Prisma recusa o `create()` da trilha — e a operação auditada cai junto, porque
    // a auditoria roda na mesma transação.
    if (Prisma.Decimal.isDecimal(value)) return value.toNumber()
    if (typeof value === 'bigint') return Number(value)
    if (Array.isArray(value)) return value.map(sanitize)
    if (typeof value !== 'object') return value

    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sensitive.has(key) ? '[redacted]' : sanitize(item)
    }
    return result
  }

  return {
    sanitize,

    async recordAudit(tx: TenantTransaction, entry: AuditEntry): Promise<void> {
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
    },
  }
}
