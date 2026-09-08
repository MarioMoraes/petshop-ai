import { hashSearchable, withTenant, type TenantTransaction } from '@petshop/db'
import type {
  CreateSuppressionInput,
  MessageChannel,
  SuppressionReason,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { notFound } from './errors.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * Endereços que não se deve mais tentar (AC-05 de MOD-CRM-04).
 *
 * Guardados **por hash**, nunca em claro: a lista de quem pediu para parar não pode
 * ser, ela mesma, uma lista de contatos exportável. O namespace do HMAC é por canal,
 * pela mesma razão que CPF e telefone têm namespaces distintos em `hashSearchable` —
 * um e-mail e um telefone com os mesmos caracteres não devem colidir.
 *
 * A supressão **sobrevive à exclusão do tutor**, e é contraintuitivo até se pensar no
 * caso: sem isso, o mesmo contato recadastrado amanhã volta a ser incomodado. É
 * interesse do titular, não do petshop.
 */

export function addressHash(channel: MessageChannel, address: string): string {
  return hashSearchable(`messaging:${channel.toLowerCase()}`, address.trim().toLowerCase())
}

/** Bloqueia? Uma supressão vencida não bloqueia mais — `expires_at` nulo é permanente. */
export async function isSuppressed(
  tx: TenantTransaction,
  channel: MessageChannel,
  address: string,
): Promise<boolean> {
  const row = await tx.messagingSuppression.findFirst({
    where: {
      channel,
      addressHash: addressHash(channel, address),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  })
  return row !== null
}

export async function suppress(
  tx: TenantTransaction,
  tenantId: string,
  channel: MessageChannel,
  address: string,
  reason: SuppressionReason,
): Promise<void> {
  const hash = addressHash(channel, address)
  await tx.messagingSuppression.upsert({
    where: { tenantId_channel_addressHash: { tenantId, channel, addressHash: hash } },
    // Um bounce em cima de uma supressão manual não rebaixa o motivo: o registro mais
    // antigo já explica por que o endereço saiu de circulação.
    update: {},
    create: { tenantId, channel, addressHash: hash, reason },
  })
}

export interface SuppressionRow {
  id: string
  channel: MessageChannel
  reason: SuppressionReason
  expiresAt: Date | null
  createdAt: Date
}

export async function listSuppressions(tenantId: string): Promise<SuppressionRow[]> {
  return withTenant(tenantId, (tx) =>
    tx.messagingSuppression.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        channel: true,
        reason: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
  )
}

export async function createSuppression(
  actor: ActorContext,
  input: CreateSuppressionInput,
): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      await suppress(tx, actor.tenantId, input.channel, input.address, input.reason)
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'messaging_suppression.created',
        entity: 'messaging_suppressions',
        // O endereço **não** entra na trilha: ela é imutável, e gravar ali o contato
        // de quem pediu para não ser mais contatado seria o oposto do que a supressão
        // existe para fazer.
        after: { channel: input.channel, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )
}

/**
 * Destravar um contato é ato deliberado — o tutor corrigiu o e-mail, ou trocou de
 * número — e por isso vai para a trilha com autor (§9).
 */
export async function removeSuppression(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const existing = await tx.messagingSuppression.findUnique({ where: { id } })
      if (!existing) throw notFound('Supressão não encontrada')

      await tx.messagingSuppression.delete({ where: { id } })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'messaging_suppression.removed',
        entity: 'messaging_suppressions',
        entityId: id,
        before: { channel: existing.channel, reason: existing.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )
}
