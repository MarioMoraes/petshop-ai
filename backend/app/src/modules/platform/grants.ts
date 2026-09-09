import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import { loadEnv } from '../../config/env.js'
import { recordAudit } from '../../shared/audit.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { publishEvent } from '../../shared/events.js'
import { invalid, invalidState, notFound } from './errors.js'

/**
 * O acesso de suporte consentido (MOD-ADMIN-02).
 *
 * **O `SUPER_ADMIN` recebe toda a matriz de permissões, e isso nunca bastou para ler a
 * ficha de um cliente de um petshop.** Quem é controlador daquele dado é o
 * estabelecimento; a plataforma é operadora (art. 5º, VI e VII da LGPD). O grant é a forma
 * de o controlador autorizar cada acesso, com motivo, prazo e registro — que é o que o
 * art. 39 pede do contrato entre os dois.
 *
 * Três coisas que o desenho fixa e não são negociáveis:
 *
 * 1. **O grant é de leitura.** Não há caminho por onde o suporte escreva. Suporte que
 *    precisa corrigir dado pede ao estabelecimento que corrija.
 * 2. **A trilha é do tenant**, não da plataforma: quem precisa ver quem entrou na base
 *    dele é ele. É o oposto da concessão do papel, que é da plataforma.
 * 3. **Nada disso entra em cache** (RN-03). O grant existe para o caso em que o
 *    estabelecimento quer que o acesso pare *agora*, e cinco minutos de chave quente
 *    dariam ao suporte cinco minutos depois do clique.
 */

export type SupportGrantStatusValue = 'REQUESTED' | 'ACTIVE' | 'DENIED' | 'EXPIRED' | 'REVOKED'

export interface SupportGrantView {
  id: string
  status: SupportGrantStatusValue
  reason: string
  requestedBy: { userId: string; fullName: string }
  requestedAt: string
  approvedAt: string | null
  expiresAt: string | null
}

/**
 * O grant vivo deste suporte neste estabelecimento, ou `null`.
 *
 * Lido **uma vez por requisição**, direto do banco. É a consulta que o índice parcial
 * `idx_grants_vivos` existe para servir.
 *
 * Passa por `getMaintenancePrisma()` porque acontece **antes** de haver contexto de
 * tenant: é ela que decide se o contexto pode ser montado. É o mesmo caminho que
 * `packages/db/src/platform.ts` usa para resolver a sessão, e pela mesma razão.
 *
 * **A expiração é conferida na leitura, não por job** (AC-04). Um grant que vence enquanto
 * a tela está aberta para de valer na ação seguinte; esperar uma varredura daria minutos
 * de acesso depois do prazo.
 */
export async function findActiveGrant(
  adminUserId: string,
  tenantId: string,
): Promise<{ id: string; expiresAt: Date } | null> {
  const grant = await getMaintenancePrisma().supportAccessGrant.findFirst({
    where: {
      adminUserId,
      tenantId,
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
    },
    select: { id: true, expiresAt: true },
  })

  return grant?.expiresAt ? { id: grant.id, expiresAt: grant.expiresAt } : null
}

/**
 * O suporte pede acesso (AC-01).
 *
 * Nasce em `REQUESTED`, **sem prazo**: quem define o prazo é quem autoriza. O evento leva
 * o motivo ao MOD-NOTIF, que avisa o administrador do estabelecimento — é a única forma de
 * ele saber que há um pedido esperando.
 */
export async function requestSupportAccess(
  admin: { userId: string; ipAddress?: string | undefined; userAgent?: string | undefined },
  tenantId: string,
  reason: string,
): Promise<SupportGrantView> {
  /**
   * O nome sai do banco, e não do contexto da requisição.
   *
   * É ele que vai na notificação ao estabelecimento — "Bruno do Suporte pediu acesso" —, e
   * o `ServiceAuthContext` carrega identificadores, nunca nome. Ler aqui custa uma consulta
   * por pedido, que é raro por definição.
   */
  const quem = await getMaintenancePrisma().user.findUnique({
    where: { id: admin.userId },
    select: { fullName: true },
  })
  const fullName = quem?.fullName ?? 'Equipe PetShop AI'

  const tenant = await getMaintenancePrisma().tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { id: true },
  })
  if (!tenant) throw notFound('Estabelecimento não encontrado')

  const aberto = await getMaintenancePrisma().supportAccessGrant.findFirst({
    where: { adminUserId: admin.userId, tenantId, status: { in: ['REQUESTED', 'ACTIVE'] } },
    select: { id: true, status: true },
  })
  if (aberto) {
    throw invalidState(
      aberto.status === 'ACTIVE'
        ? 'Você já tem acesso ativo a este estabelecimento'
        : 'Você já tem um pedido aguardando resposta deste estabelecimento',
    )
  }

  const created = await withTenant(tenantId, (tx) =>
    tx.supportAccessGrant.create({
      data: { tenantId, adminUserId: admin.userId, reason },
      select: { id: true, createdAt: true },
    }),
  )

  /**
   * A trilha vai para o **estabelecimento**, e não para a plataforma.
   *
   * É o inverso da concessão do papel: quem precisa saber que alguém de fora pediu acesso
   * à base dele é ele. A tela de auditoria que o MOD-SEC-05 entregou já mostra estas
   * linhas sem precisar de nada novo.
   */
  await withTenant(tenantId, (tx) =>
    recordAudit(tx, {
      tenantId,
      action: 'support.requested',
      entity: 'support_access_grant',
      entityId: created.id,
      actorUserId: admin.userId,
      after: { reason },
      ipAddress: admin.ipAddress ?? null,
      userAgent: admin.userAgent ?? null,
    }),
  )

  await publishEvent('suporte.acesso.solicitado', {
    tenantId,
    grantId: created.id,
    reason,
    requestedBy: fullName,
  })

  recordMetric({ metric: 'support_grant_requested_total', tenantId, value: 1, unit: 'count' })

  return {
    id: created.id,
    status: 'REQUESTED',
    reason,
    requestedBy: { userId: admin.userId, fullName },
    requestedAt: created.createdAt.toISOString(),
    approvedAt: null,
    expiresAt: null,
  }
}

/** Os grants **deste** estabelecimento, para a tela dele. */
export async function listSupportAccess(tenantId: string): Promise<SupportGrantView[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.supportAccessGrant.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        reason: true,
        adminUserId: true,
        createdAt: true,
        approvedAt: true,
        expiresAt: true,
        admin: { select: { fullName: true } },
      },
    }),
  )

  return rows.map((row) => ({
    id: row.id,
    status: row.status as SupportGrantStatusValue,
    reason: row.reason,
    requestedBy: { userId: row.adminUserId, fullName: row.admin.fullName },
    requestedAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }))
}

interface TenantActor {
  tenantId: string
  actorUserId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

/**
 * O estabelecimento aprova, e é aqui que o prazo nasce (AC-02).
 *
 * **O teto é do servidor**, e o tenant pode encurtar mas nunca esticar: `hours` é validado
 * contra `SUPPORT_GRANT_MAX_HOURS`. Um prazo que o cliente escolhe sem teto é um grant
 * permanente com outro nome.
 */
export async function approveSupportAccess(
  actor: TenantActor,
  grantId: string,
  hours: number,
): Promise<SupportGrantView> {
  const teto = loadEnv().SUPPORT_GRANT_MAX_HOURS
  if (hours > teto) throw invalid(`O prazo máximo é de ${teto} horas`)

  const expiresAt = new Date(Date.now() + hours * 3_600_000)

  const updated = await withTenant(actor.tenantId, async (tx) => {
    const grant = await loadPending(tx, grantId)

    const row = await tx.supportAccessGrant.update({
      where: { id: grant.id },
      data: {
        status: 'ACTIVE',
        approvedBy: actor.actorUserId ?? null,
        approvedAt: new Date(),
        expiresAt,
      },
      select: {
        id: true,
        status: true,
        reason: true,
        adminUserId: true,
        createdAt: true,
        approvedAt: true,
        expiresAt: true,
        admin: { select: { fullName: true } },
      },
    })

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      action: 'support.approved',
      entity: 'support_access_grant',
      entityId: grant.id,
      actorUserId: actor.actorUserId ?? null,
      after: { expiresAt: expiresAt.toISOString(), hours },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })

    return row
  })

  await publishEvent('suporte.acesso.concedido', {
    tenantId: actor.tenantId,
    grantId,
    expiresAt: expiresAt.toISOString(),
  })
  recordMetric({
    metric: 'support_grant_approved_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return {
    id: updated.id,
    status: updated.status as SupportGrantStatusValue,
    reason: updated.reason,
    requestedBy: { userId: updated.adminUserId, fullName: updated.admin.fullName },
    requestedAt: updated.createdAt.toISOString(),
    approvedAt: updated.approvedAt?.toISOString() ?? null,
    expiresAt: updated.expiresAt?.toISOString() ?? null,
  }
}

/** O estabelecimento recusa o pedido. */
export async function denySupportAccess(actor: TenantActor, grantId: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const grant = await loadPending(tx, grantId)
    await tx.supportAccessGrant.update({ where: { id: grant.id }, data: { status: 'DENIED' } })
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      action: 'support.denied',
      entity: 'support_access_grant',
      entityId: grant.id,
      actorUserId: actor.actorUserId ?? null,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })
  })

  await publishEvent('suporte.acesso.negado', { tenantId: actor.tenantId, grantId })
}

/**
 * O estabelecimento revoga um acesso ativo (AC-05).
 *
 * Vale **no clique**: a próxima requisição do suporte já não encontra grant vivo, porque a
 * checagem lê o banco a cada requisição e não há cache no caminho.
 */
export async function revokeSupportAccess(actor: TenantActor, grantId: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const grant = await tx.supportAccessGrant.findFirst({
      where: { id: grantId },
      select: { id: true, status: true },
    })
    if (!grant) throw notFound('Acesso não encontrado')
    if (grant.status !== 'ACTIVE') {
      throw invalidState('Este acesso não está ativo')
    }

    await tx.supportAccessGrant.update({
      where: { id: grant.id },
      data: { status: 'REVOKED', revokedBy: actor.actorUserId ?? null, revokedAt: new Date() },
    })

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      action: 'support.revoked',
      entity: 'support_access_grant',
      entityId: grant.id,
      actorUserId: actor.actorUserId ?? null,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })
  })

  await publishEvent('suporte.acesso.revogado', { tenantId: actor.tenantId, grantId })
}

async function loadPending(tx: TenantTransaction, grantId: string) {
  const grant = await tx.supportAccessGrant.findFirst({
    where: { id: grantId },
    select: { id: true, status: true },
  })
  if (!grant) throw notFound('Pedido de acesso não encontrado')
  if (grant.status !== 'REQUESTED') {
    throw invalidState('Este pedido já foi respondido')
  }
  return grant
}

/**
 * A leitura sob grant vira uma linha na trilha **do estabelecimento** (AC-06).
 *
 * Uma por requisição, com a rota e o grant. É o que torna o acesso verificável pelo lado
 * de quem autorizou — sem isso, o grant seria uma promessa sem prova.
 *
 * **Nunca lança**: uma falha de registro não pode derrubar a leitura que ela descreve, e
 * um 500 aqui esconderia o acesso em vez de registrá-lo. A falha vira log de erro, que é o
 * sinal de que a prova parou de ser produzida.
 */
export async function recordSupportRead(input: {
  tenantId: string
  grantId: string
  adminUserId: string
  method: string
  path: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}): Promise<void> {
  try {
    await withTenant(input.tenantId, (tx) =>
      recordAudit(tx, {
        tenantId: input.tenantId,
        action: 'support.read',
        entity: 'route',
        entityId: input.path,
        actorUserId: input.adminUserId,
        after: { grantId: input.grantId, method: input.method },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      }),
    )
    recordMetric({
      metric: 'support_read_total',
      tenantId: input.tenantId,
      value: 1,
      unit: 'count',
    })
  } catch (error) {
    logger.error({ err: error, tenantId: input.tenantId }, 'falha ao registrar leitura de suporte')
  }
}
