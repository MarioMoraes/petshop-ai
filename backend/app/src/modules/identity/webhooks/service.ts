import {
  Prisma,
  encryptPlatform,
  getPrisma,
  hashEmail,
  listUserMemberships,
  resolveTenantByClerkOrgId,
  withTenant,
} from '@petshop/db'
import { recordAudit, recordPlatformAudit } from '../../../shared/audit.js'
import { logger } from '../../../shared/logger.js'
import { CACHE_KEYS, cacheDelete } from '../../../shared/redis.js'
import { invalidatePermissions } from '../rbac/service.js'

/**
 * MOD-IDENT-03 — a sincronização com o Clerk.
 *
 * O espelho em `users` era criado sob demanda por `ensureLocalUser` e nunca mais
 * atualizado: quem trocasse nome, foto ou e-mail no Clerk ficava com o dado velho no
 * produto para sempre. Este arquivo é quem fecha essa lacuna, e `users.clerk_synced_at`
 * já existia no schema esperando por ele.
 *
 * Três decisões governam o arquivo inteiro:
 *
 * - **A idempotência é a constraint, não uma leitura.** O Clerk reentrega o que não
 *   recebe 2xx depressa, e duas entregas do mesmo `svix-id` chegam juntas. A linha em
 *   `webhook_events` é inserida **antes** do trabalho e é ela que reserva o evento; a
 *   segunda entrega bate no índice único e vai embora sem aplicar nada.
 * - **Falha de programa devolve o id.** Erro inesperado apaga a linha e reergue, para
 *   que a reentrega do Clerk tenha o que fazer. O que **não** se devolve é a falha que
 *   nenhuma reentrega resolve — a colisão de e-mail da RN-12 —, porque insistir faria o
 *   provedor reenviar para sempre um conflito que só sai à mão.
 * - **Saída da Organization suspende, não remove.** `SUSPENDED` já barra
 *   (`resolveEffectivePermissions` só enxerga vínculo ativo) e é reversível. Remover
 *   deixaria o painel do Clerk apagar equipe do produto sem volta.
 */

/** Os tipos que movem alguma coisa. O resto o Clerk pode mandar; nada acontece. */
const HANDLED = new Set([
  'user.created',
  'user.updated',
  'user.deleted',
  'organizationMembership.deleted',
])

export type ClerkWebhookOutcome = 'PROCESSED' | 'IGNORED' | 'FAILED'

export interface ClerkWebhookResult {
  outcome: ClerkWebhookOutcome
  eventType: string
  /** Por que nada foi aplicado, quando foi o caso. Vai para o log, nunca para a rota. */
  reason?: string
}

interface ClerkWebhookPayload {
  type?: unknown
  data?: Record<string, unknown>
}

/**
 * Erro de domínio que **não** se resolve reentregando: a linha fica `FAILED` e a rota
 * responde 204.
 */
class UnrecoverableEvent extends Error {}

export async function applyClerkWebhook(
  payload: ClerkWebhookPayload,
  svixId: string,
): Promise<ClerkWebhookResult> {
  const eventType = typeof payload.type === 'string' ? payload.type : ''

  /**
   * Evento que não tratamos **não vira linha**.
   *
   * O painel do Clerk deixa escolher o que enviar, mas quem configura pode marcar tudo —
   * e `session.created` sozinho encheria a tabela com milhares de linhas por dia. Nada é
   * aplicado, então não há idempotência a proteger.
   */
  if (!HANDLED.has(eventType)) {
    return { outcome: 'IGNORED', eventType, reason: 'tipo não tratado' }
  }

  const prisma = getPrisma()

  try {
    await prisma.webhookEvent.create({
      data: { provider: 'clerk', externalEventId: svixId, eventType },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Reentrega ou duas cópias simultâneas do mesmo evento (RN-09).
      logger.debug({ svixId, eventType }, 'evento do Clerk já processado')
      return { outcome: 'IGNORED', eventType, reason: 'evento repetido' }
    }
    throw error
  }

  try {
    const result = await aplicar(eventType, payload.data ?? {})
    await prisma.webhookEvent.updateMany({
      where: { provider: 'clerk', externalEventId: svixId },
      data: { status: result.outcome, error: result.reason ?? null, processedAt: new Date() },
    })
    return { ...result, eventType }
  } catch (error) {
    if (error instanceof UnrecoverableEvent) {
      await prisma.webhookEvent.updateMany({
        where: { provider: 'clerk', externalEventId: svixId },
        data: { status: 'FAILED', error: error.message.slice(0, 300), processedAt: new Date() },
      })
      logger.error({ svixId, eventType }, `webhook do Clerk falhou: ${error.message}`)
      return { outcome: 'FAILED', eventType, reason: error.message }
    }

    /**
     * Defeito nosso, e não fato do outro lado: a linha que reservou o id **sai**, para
     * que a reentrega do Clerk encontre o caminho livre. Sem isso um bug transitório
     * sumiria com o evento em silêncio, que é o pior desfecho possível num sincronizador.
     */
    await prisma.webhookEvent.deleteMany({
      where: { provider: 'clerk', externalEventId: svixId },
    })
    throw error
  }
}

async function aplicar(
  eventType: string,
  data: Record<string, unknown>,
): Promise<{ outcome: ClerkWebhookOutcome; reason?: string }> {
  if (eventType === 'user.deleted') return aplicarUsuarioApagado(data)
  if (eventType === 'organizationMembership.deleted') return aplicarSaidaDaOrganization(data)
  return aplicarUsuario(data)
}

// ─── user.created e user.updated ─────────────────────────────────────────────

interface ClerkEmailAddress {
  id?: unknown
  email_address?: unknown
}

function texto(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * O e-mail primário, com a mesma regra do `getUser` da porta: o que casa com
 * `primary_email_address_id`, e na falta dele o primeiro da lista.
 */
function emailPrimario(data: Record<string, unknown>): string | null {
  const enderecos = Array.isArray(data.email_addresses)
    ? (data.email_addresses as ClerkEmailAddress[])
    : []
  const primario =
    enderecos.find((endereco) => endereco.id === data.primary_email_address_id) ?? enderecos[0]
  return texto(primario?.email_address)
}

async function aplicarUsuario(
  data: Record<string, unknown>,
): Promise<{ outcome: ClerkWebhookOutcome; reason?: string }> {
  const clerkUserId = texto(data.id)
  if (!clerkUserId) return { outcome: 'IGNORED', reason: 'payload sem id de usuário' }

  const email = emailPrimario(data)
  if (!email) {
    // Usuário do Clerk sem e-mail nenhum não tem como virar linha nossa: `email_hash` é
    // NOT NULL e é a chave de busca. Mesma recusa do `getUser` da porta.
    return { outcome: 'IGNORED', reason: 'usuário sem e-mail no Clerk' }
  }

  /**
   * RN-09 — a versão do evento, e não a hora em que ele chegou.
   *
   * `clerk_synced_at` guarda o `updated_at` do payload aplicado. É o que permite
   * descartar um `user.updated` que vem fora de ordem: carimbo menor ou igual ao
   * gravado não tem nada a dizer que já não esteja lá. Gravar `now()` em vez disso
   * faria toda reentrega parecer mais nova que o dado.
   */
  const updatedAt = typeof data.updated_at === 'number' ? new Date(data.updated_at) : null

  const nome = [texto(data.first_name), texto(data.last_name)].filter(Boolean).join(' ').trim()
  const prisma = getPrisma()
  const existente = await prisma.user.findUnique({
    where: { clerkUserId },
    select: { id: true, clerkSyncedAt: true },
  })

  if (existente && updatedAt && existente.clerkSyncedAt && updatedAt <= existente.clerkSyncedAt) {
    return { outcome: 'IGNORED', reason: 'evento mais antigo que o espelho' }
  }

  const campos = {
    emailEncrypted: encryptPlatform(email),
    emailHash: hashEmail(email),
    fullName: (nome || email).slice(0, 120),
    avatarUrl: texto(data.image_url),
    mfaEnabled: data.two_factor_enabled === true,
    clerkSyncedAt: updatedAt ?? new Date(),
  }

  try {
    if (existente) {
      await prisma.user.update({ where: { id: existente.id }, data: campos })
    } else {
      await prisma.user.create({ data: { clerkUserId, ...campos } })
    }
  } catch (error) {
    /**
     * RN-12 — a colisão de e-mail.
     *
     * Duas contas do Clerk passaram a apontar para o mesmo endereço, e não há como
     * adivinhar qual é a dona legítima: o caso vai para intervenção humana, pela linha
     * `FAILED` que a regra `clerk_webhook_failing` conta no painel da plataforma. A
     * mensagem **não** carrega o endereço — a tabela é lida por quem não precisa dele
     * para agir.
     *
     * Qualquer outro erro sobe, inclusive o `P2002` de `clerk_user_id`: aquele é a
     * corrida entre duas entregas do mesmo usuário, e reentregar resolve.
     */
    const alvo =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
        ? ((error.meta?.target as string[] | undefined)?.join(',') ?? '')
        : ''
    if (alvo.includes('email_hash')) {
      throw new UnrecoverableEvent('e-mail já pertence a outro usuário')
    }
    throw error
  }

  await cacheDelete(CACHE_KEYS.userByClerkId(clerkUserId))

  await recordPlatformAudit({
    action: 'user.synced',
    entity: 'user',
    entityId: existente?.id ?? clerkUserId,
    after: { source: 'clerk_webhook' },
  })

  return { outcome: 'PROCESSED' }
}

// ─── user.deleted ────────────────────────────────────────────────────────────

/**
 * A conta saiu do Clerk.
 *
 * **Suspende os vínculos; não os remove, e não respeita a guarda do último
 * administrador.** O webhook não tem como recusar um fato que já aconteceu do outro
 * lado — o que ele pode fazer é deixar o estabelecimento sem administrador nunca passar
 * calado, e é o que o `logger.error` abaixo faz.
 */
async function aplicarUsuarioApagado(
  data: Record<string, unknown>,
): Promise<{ outcome: ClerkWebhookOutcome; reason?: string }> {
  const clerkUserId = texto(data.id)
  if (!clerkUserId) return { outcome: 'IGNORED', reason: 'payload sem id de usuário' }

  const prisma = getPrisma()
  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    select: { id: true, status: true },
  })
  if (!user) return { outcome: 'IGNORED', reason: 'usuário sem espelho local' }

  await prisma.user.update({
    where: { id: user.id },
    data: { status: 'DISABLED', clerkSyncedAt: new Date() },
  })

  const vinculos = (await listUserMemberships(user.id)).filter(
    (membership) => membership.status === 'ACTIVE',
  )

  for (const vinculo of vinculos) {
    await suspenderVinculo(vinculo.tenantId, user.id, 'clerk_user_deleted')
  }

  await Promise.all([
    cacheDelete(CACHE_KEYS.userByClerkId(clerkUserId)),
    recordPlatformAudit({
      action: 'user.disabled',
      entity: 'user',
      entityId: user.id,
      after: { source: 'clerk_webhook', suspendedMemberships: vinculos.length },
    }),
  ])

  return { outcome: 'PROCESSED' }
}

// ─── organizationMembership.deleted ──────────────────────────────────────────

async function aplicarSaidaDaOrganization(
  data: Record<string, unknown>,
): Promise<{ outcome: ClerkWebhookOutcome; reason?: string }> {
  const organization = (data.organization ?? {}) as Record<string, unknown>
  const publicUserData = (data.public_user_data ?? {}) as Record<string, unknown>
  const clerkOrgId = texto(organization.id)
  const clerkUserId = texto(publicUserData.user_id)
  if (!clerkOrgId || !clerkUserId) {
    return { outcome: 'IGNORED', reason: 'payload sem Organization ou usuário' }
  }

  const tenant = await resolveTenantByClerkOrgId(clerkOrgId)
  if (!tenant) {
    // Organization sem tenant local: o mesmo caso órfão que o `session.ts` já loga.
    return { outcome: 'IGNORED', reason: 'Organization sem tenant local' }
  }

  const user = await getPrisma().user.findUnique({
    where: { clerkUserId },
    select: { id: true },
  })
  if (!user) return { outcome: 'IGNORED', reason: 'usuário sem espelho local' }

  const suspensos = await suspenderVinculo(tenant.id, user.id, 'clerk_organization_removed')
  if (suspensos === 0) return { outcome: 'IGNORED', reason: 'vínculo já não estava ativo' }

  return { outcome: 'PROCESSED' }
}

// ─── O gesto comum ───────────────────────────────────────────────────────────

/**
 * Suspende o vínculo ativo e devolve quantos foram — zero é o caso normal de um evento
 * repetido ou de quem já tinha saído.
 *
 * `permVersion` incrementa junto: quem está com token válido na mão precisa que o
 * gateway detecte a divergência e releia o banco, senão continua operando com a
 * permissão de antes por até oito minutos (RN-03).
 */
async function suspenderVinculo(
  tenantId: string,
  userId: string,
  motivo: string,
): Promise<number> {
  const { count, semAdministrador } = await withTenant(tenantId, async (tx) => {
    const { count } = await tx.membership.updateMany({
      where: { tenantId, userId, status: 'ACTIVE' },
      data: { status: 'SUSPENDED', permVersion: { increment: 1 } },
    })
    if (count === 0) return { count, semAdministrador: false }

    await recordAudit(tx, {
      tenantId,
      // Ação de sistema: não há ator humano do nosso lado, e inventar um seria pior que
      // a coluna nula que a trilha já prevê.
      actorUserId: null,
      action: 'membership.suspended',
      entity: 'membership',
      entityId: userId,
      after: { reason: motivo },
    })

    const administradores = await tx.membership.count({
      where: { tenantId, roleKey: 'TENANT_ADMIN', status: 'ACTIVE' },
    })
    return { count, semAdministrador: administradores === 0 }
  })

  if (semAdministrador) {
    logger.error(
      { tenantId, userId, motivo },
      'estabelecimento ficou sem administrador ativo depois de evento do Clerk',
    )
  }

  if (count > 0) await invalidatePermissions(tenantId, userId)
  return count
}
