import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PermissionKey, RoleKey } from '@petshop/shared-types'

/**
 * Contrato de confiança entre o api-gateway e os microserviços.
 *
 * O gateway é quem valida o JWT do Clerk e resolve tenant e permissões. Os serviços
 * atrás dele recebem esse resultado por header — e precisam saber que veio mesmo do
 * gateway, não de alguém que alcançou a porta do serviço direto. Daí a assinatura
 * HMAC sobre o conjunto de headers, com o segredo compartilhado
 * `INTERNAL_SERVICE_SECRET`.
 *
 * A assinatura carrega um timestamp e é rejeitada fora de uma janela curta, para que
 * um header capturado não seja reutilizável indefinidamente.
 */

export const SERVICE_HEADERS = {
  clerkUserId: 'x-petshop-clerk-user-id',
  userId: 'x-petshop-user-id',
  tenantId: 'x-petshop-tenant-id',
  role: 'x-petshop-role',
  permissions: 'x-petshop-permissions',
  permVersion: 'x-petshop-perm-version',
  timestamp: 'x-petshop-timestamp',
  signature: 'x-petshop-signature',
  requestId: 'x-request-id',
} as const

/** Tolerância do timestamp assinado. */
export const SIGNATURE_MAX_AGE_MS = 60_000

export interface ServiceAuthContext {
  clerkUserId: string
  /** UUID local. Ausente antes do primeiro acesso, quando o espelho ainda não existe. */
  userId?: string
  /** Ausente quando o usuário ainda não tem tenant — é o caso de `POST /v1/tenants`. */
  tenantId?: string
  role?: RoleKey
  permissions: PermissionKey[]
  permVersion?: number
}

type HeaderBag = Record<string, string | string[] | undefined>

function canonicalPayload(context: ServiceAuthContext, timestamp: number): string {
  // Ordem fixa e explícita: a assinatura precisa ser reproduzível dos dois lados.
  return [
    context.clerkUserId,
    context.userId ?? '',
    context.tenantId ?? '',
    context.role ?? '',
    [...context.permissions].sort().join(','),
    context.permVersion?.toString() ?? '',
    timestamp.toString(),
  ].join('|')
}

export function signServiceHeaders(
  context: ServiceAuthContext,
  secret: string,
  now = Date.now(),
): Record<string, string> {
  const signature = createHmac('sha256', secret)
    .update(canonicalPayload(context, now))
    .digest('hex')

  const headers: Record<string, string> = {
    [SERVICE_HEADERS.clerkUserId]: context.clerkUserId,
    [SERVICE_HEADERS.permissions]: [...context.permissions].sort().join(','),
    [SERVICE_HEADERS.timestamp]: now.toString(),
    [SERVICE_HEADERS.signature]: signature,
  }
  if (context.userId) headers[SERVICE_HEADERS.userId] = context.userId
  if (context.tenantId) headers[SERVICE_HEADERS.tenantId] = context.tenantId
  if (context.role) headers[SERVICE_HEADERS.role] = context.role
  if (context.permVersion !== undefined) {
    headers[SERVICE_HEADERS.permVersion] = context.permVersion.toString()
  }
  return headers
}

export type VerifyFailure =
  | 'MISSING_SIGNATURE'
  | 'MISSING_USER'
  | 'STALE_TIMESTAMP'
  | 'BAD_SIGNATURE'

export type VerifyResult =
  | { ok: true; context: ServiceAuthContext }
  | { ok: false; reason: VerifyFailure }

function readHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

export function verifyServiceHeaders(
  headers: HeaderBag,
  secret: string,
  now = Date.now(),
): VerifyResult {
  const signature = readHeader(headers, SERVICE_HEADERS.signature)
  const timestampRaw = readHeader(headers, SERVICE_HEADERS.timestamp)
  if (!signature || !timestampRaw) return { ok: false, reason: 'MISSING_SIGNATURE' }

  const clerkUserId = readHeader(headers, SERVICE_HEADERS.clerkUserId)
  if (!clerkUserId) return { ok: false, reason: 'MISSING_USER' }

  const timestamp = Number(timestampRaw)
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: 'STALE_TIMESTAMP' }
  }

  const permissionsRaw = readHeader(headers, SERVICE_HEADERS.permissions) ?? ''
  const permVersionRaw = readHeader(headers, SERVICE_HEADERS.permVersion)

  const context: ServiceAuthContext = {
    clerkUserId,
    permissions: permissionsRaw ? (permissionsRaw.split(',') as PermissionKey[]) : [],
  }
  const userId = readHeader(headers, SERVICE_HEADERS.userId)
  const tenantId = readHeader(headers, SERVICE_HEADERS.tenantId)
  const role = readHeader(headers, SERVICE_HEADERS.role)
  if (userId) context.userId = userId
  if (tenantId) context.tenantId = tenantId
  if (role) context.role = role as RoleKey
  if (permVersionRaw) context.permVersion = Number(permVersionRaw)

  const expected = createHmac('sha256', secret)
    .update(canonicalPayload(context, timestamp))
    .digest('hex')

  const provided = Buffer.from(signature, 'hex')
  const computed = Buffer.from(expected, 'hex')
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }

  return { ok: true, context }
}
