import { Prisma, getMaintenancePrisma, withTenant } from '@petshop/db'
import {
  EMAIL_DOMAIN_CHECK_WINDOW_HOURS,
  type EmailDomain,
  type EmailDomainResponse,
  type SetEmailDomainInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { logger } from '../../shared/logger.js'
import { invalidateSettings } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { emailDomainTaken, providerUnavailable } from './errors.js'
import {
  ResendDomainsError,
  getResendDomainsPort,
  type DomainRecord,
  type ProviderDomain,
} from './ports/resend-domains.js'

/**
 * O domínio de e-mail próprio do estabelecimento (Configurações › Integrações).
 *
 * O e-mail ao tutor sai de `MAIL_FROM` — o domínio da PetShop AI — até o petshop cadastrar
 * o dele e o DNS verificar. **Só `VERIFIED` muda o remetente**: o Resend recusa qualquer
 * envio de domínio não verificado, e trocar o remetente antes da hora seria trocar
 * "e-mail saindo pelo endereço da plataforma" por "e-mail não saindo".
 *
 * Quem registra o domínio é a conta Resend da plataforma (`ports/resend-domains.ts`). O
 * banco guarda o id de lá, o estado e os registros de DNS, para a tela desenhar a tabela
 * sem consultar o provedor a cada visita.
 */

const DEFAULT_LOCAL_PART = 'contato'

type Row = {
  domain: string
  localPart: string
  resendDomainId: string
  status: EmailDomain['status']
  records: Prisma.JsonValue
  verifiedAt: Date | null
  lastCheckedAt: Date | null
}

function toApi(row: Row): EmailDomain {
  return {
    domain: row.domain,
    localPart: row.localPart,
    fromAddress: `${row.localPart}@${row.domain}`,
    status: row.status,
    records: (Array.isArray(row.records) ? row.records : []) as unknown as DomainRecord[],
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
  }
}

/** O provedor recusou por falta de acesso — a chave da instalação é de *só envio*. */
function unavailable(): never {
  throw providerUnavailable(
    'O domínio próprio não está disponível nesta instalação. Fale com o suporte da PetShop AI.',
  )
}

function translate(error: unknown): never {
  if (error instanceof ResendDomainsError) {
    // O domínio que já está na conta chega como 403 ou 422, conforme a versão da API — é
    // o texto que o distingue da chave sem acesso a domínios, e por isso vem primeiro.
    if (/already|exist|registered/i.test(error.message)) throw emailDomainTaken()
    if (error.status === 401 || error.status === 403) unavailable()
    throw providerUnavailable(
      'O Resend não conseguiu registrar o domínio agora. Tente em instantes.',
    )
  }
  throw error
}

export async function getEmailDomain(tenantId: string): Promise<EmailDomainResponse> {
  const row = await withTenant(tenantId, (tx) => tx.emailDomain.findUnique({ where: { tenantId } }))
  return {
    available: getResendDomainsPort().configured(),
    domain: row ? toApi(row) : null,
  }
}

export async function setEmailDomain(
  actor: ActorContext,
  input: SetEmailDomainInput,
): Promise<EmailDomainResponse> {
  const port = getResendDomainsPort()
  if (!port.configured()) unavailable()

  const tenantId = actor.tenantId
  const localPart = input.localPart ?? DEFAULT_LOCAL_PART

  const current = await withTenant(tenantId, (tx) =>
    tx.emailDomain.findUnique({ where: { tenantId } }),
  )

  // Mesmo domínio: só o endereço muda. Não há o que registrar de novo no provedor, e o
  // estado de verificação continua valendo — o DNS é do domínio, não da caixa.
  if (current && current.domain === input.domain) {
    await withTenant(
      tenantId,
      async (tx) => {
        await tx.emailDomain.update({ where: { tenantId }, data: { localPart } })
        await recordAudit(tx, {
          tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'messaging.email_domain_changed',
          entity: 'email_domain',
          entityId: tenantId,
          before: { fromAddress: `${current.localPart}@${current.domain}` },
          after: { fromAddress: `${localPart}@${input.domain}` },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })
      },
      tenantOptions(actor),
    )
    await invalidateSettings(tenantId)
    return getEmailDomain(tenantId)
  }

  let created: ProviderDomain
  try {
    created = await port.create(input.domain)
  } catch (error) {
    translate(error)
  }

  try {
    await withTenant(
      tenantId,
      async (tx) => {
        const data = {
          domain: input.domain,
          localPart,
          resendDomainId: created.id,
          status: created.status,
          records: created.records as unknown as Prisma.InputJsonValue,
          verifiedAt: created.status === 'VERIFIED' ? new Date() : null,
          lastCheckedAt: new Date(),
        }
        await tx.emailDomain.upsert({
          where: { tenantId },
          create: { tenantId, ...data },
          update: data,
        })
        await recordAudit(tx, {
          tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'messaging.email_domain_set',
          entity: 'email_domain',
          entityId: tenantId,
          before: current ? { domain: current.domain } : null,
          after: { domain: input.domain, localPart },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })
      },
      tenantOptions(actor),
    )
  } catch (error) {
    // O provedor aceitou e o banco não: desfaz lá, para o domínio não ficar preso na
    // conta sem dono. A falha desse desfazer não esconde a original.
    await port.remove(created.id).catch(() => undefined)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw emailDomainTaken()
    }
    throw error
  }

  // O domínio antigo sai do provedor depois que o novo já está gravado: na ordem inversa,
  // uma falha no meio deixaria o petshop sem domínio nenhum.
  if (current) {
    await port.remove(current.resendDomainId).catch((error: unknown) => {
      logger.warn({ err: error, tenantId }, 'domínio antigo ficou na conta do Resend')
    })
  }

  await invalidateSettings(tenantId)
  return getEmailDomain(tenantId)
}

/** Aplica o que o provedor respondeu. Devolve se o estado mudou. */
async function applyProviderState(
  tenantId: string,
  provider: ProviderDomain,
  now: Date,
  options?: Parameters<typeof withTenant>[2],
): Promise<boolean> {
  return withTenant(
    tenantId,
    async (tx) => {
      const before = await tx.emailDomain.findUnique({
        where: { tenantId },
        select: { status: true, resendDomainId: true },
      })
      // O petshop trocou de domínio no meio da conferência: a resposta é de outro.
      if (!before || before.resendDomainId !== provider.id) return false

      await tx.emailDomain.update({
        where: { tenantId },
        data: {
          status: provider.status,
          records: provider.records as unknown as Prisma.InputJsonValue,
          lastCheckedAt: now,
          ...(provider.status === 'VERIFIED' && before.status !== 'VERIFIED'
            ? { verifiedAt: now }
            : {}),
          ...(provider.status !== 'VERIFIED' ? { verifiedAt: null } : {}),
        },
      })
      return before.status !== provider.status
    },
    options,
  )
}

export async function verifyEmailDomain(actor: ActorContext): Promise<EmailDomainResponse> {
  const port = getResendDomainsPort()
  if (!port.configured()) unavailable()

  const row = await withTenant(actor.tenantId, (tx) =>
    tx.emailDomain.findUnique({ where: { tenantId: actor.tenantId } }),
  )
  if (!row) return getEmailDomain(actor.tenantId)

  let provider: ProviderDomain
  try {
    await port.verify(row.resendDomainId)
    provider = await port.get(row.resendDomainId)
  } catch (error) {
    translate(error)
  }

  const changed = await applyProviderState(
    actor.tenantId,
    provider,
    new Date(),
    tenantOptions(actor),
  )
  if (changed) await invalidateSettings(actor.tenantId)
  return getEmailDomain(actor.tenantId)
}

export async function removeEmailDomain(actor: ActorContext): Promise<EmailDomainResponse> {
  const tenantId = actor.tenantId
  const removed = await withTenant(
    tenantId,
    async (tx) => {
      const row = await tx.emailDomain.findUnique({ where: { tenantId } })
      if (!row) return null
      await tx.emailDomain.delete({ where: { tenantId } })
      await recordAudit(tx, {
        tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'messaging.email_domain_removed',
        entity: 'email_domain',
        entityId: tenantId,
        before: { domain: row.domain, localPart: row.localPart },
        after: null,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
      return row
    },
    tenantOptions(actor),
  )

  if (removed) {
    await invalidateSettings(tenantId)
    // Depois do banco: o remetente volta ao da plataforma na hora, e o domínio que
    // sobrar no provedor por uma falha aqui não muda nada no envio.
    await getResendDomainsPort()
      .remove(removed.resendDomainId)
      .catch((error: unknown) => {
        logger.warn({ err: error, tenantId }, 'domínio removido ficou na conta do Resend')
      })
  }
  return getEmailDomain(tenantId)
}

/**
 * A varredura dos pendentes (`messaging.email-domain-check`).
 *
 * O DNS propaga sozinho, e quem publicou os registros não deveria precisar voltar à tela
 * para apertar um botão. Dentro da janela de 72 horas pergunta ao provedor; passada ela,
 * o domínio vira `FAILED` e a varredura para de gastar chamada — o "Verificar agora"
 * continua valendo para quem corrigir depois.
 */
export async function checkPendingDomains(now = new Date()): Promise<{
  checked: number
  verified: number
  failed: number
}> {
  const port = getResendDomainsPort()
  if (!port.configured()) return { checked: 0, verified: 0, failed: 0 }

  const pending = await getMaintenancePrisma().emailDomain.findMany({
    where: { status: 'PENDING' },
    select: { tenantId: true, resendDomainId: true, createdAt: true },
  })

  const deadline = now.getTime() - EMAIL_DOMAIN_CHECK_WINDOW_HOURS * 3_600_000
  let checked = 0
  let verified = 0
  let failed = 0

  for (const row of pending) {
    try {
      if (row.createdAt.getTime() < deadline) {
        await withTenant(row.tenantId, (tx) =>
          tx.emailDomain.updateMany({
            where: { tenantId: row.tenantId, status: 'PENDING' },
            data: { status: 'FAILED', lastCheckedAt: now },
          }),
        )
        failed += 1
        continue
      }

      const provider = await port.get(row.resendDomainId)
      checked += 1
      if (await applyProviderState(row.tenantId, provider, now)) {
        await invalidateSettings(row.tenantId)
        if (provider.status === 'VERIFIED') verified += 1
      }
    } catch (error) {
      // Um provedor fora do ar não interrompe a varredura dos demais.
      logger.warn({ err: error, tenantId: row.tenantId }, 'conferência do domínio de e-mail falhou')
    }
  }

  return { checked, verified, failed }
}
