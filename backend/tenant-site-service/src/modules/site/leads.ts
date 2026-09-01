import { hashSearchable, withTenant } from '@petshop/db'
import {
  SITE_ROUTING_KEYS,
  TUTOR_PHONE_HASH_NAMESPACE,
  type SiteLead,
  type SiteLeadInput,
  type SiteLeadStatus,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/events.js'
import { invalidLeadTransition, leadNotFound, tooManySubmissions } from '../../lib/errors.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { decryptOptional, openCipher } from './crypto.js'
import { withinRateLimit } from './rate-limit.js'
import { resolveTenant } from './resolve.js'

/**
 * Captação e fila de leads (MOD-SITE-08 e 09).
 *
 * O lead é a primeira categoria de **pessoa sem vínculo nenhum** do sistema: alguém
 * que preencheu um formulário e talvez nunca mais apareça. Todo o resto do produto
 * trata dados de quem tem relação com o petshop — cliente, pet, funcionário. É essa
 * diferença que explica a cifra, a retenção do RN-11 e o cuidado com o que a
 * superfície pública devolve.
 */

interface LeadRow {
  id: string
  name: string
  phoneEncrypted: string
  emailEncrypted: string | null
  message: string | null
  status: SiteLeadStatus
  existingTutorId: string | null
  convertedTutorId: string | null
  note: string | null
  purgedAt: Date | null
  createdAt: Date
}

const LEAD_SELECT = {
  id: true,
  name: true,
  phoneEncrypted: true,
  emailEncrypted: true,
  message: true,
  status: true,
  existingTutorId: true,
  convertedTutorId: true,
  note: true,
  purgedAt: true,
  createdAt: true,
} as const

function toDto(row: LeadRow, decrypt: (payload: string | null) => string | null): SiteLead {
  return {
    id: row.id,
    name: row.name,
    // Linha com PII apagado pela retenção: o telefone não existe mais, e a fila
    // mostra a linha como histórico em vez de sumir com ela.
    phone: row.purgedAt ? null : decrypt(row.phoneEncrypted),
    email: row.purgedAt ? null : decrypt(row.emailEncrypted),
    message: row.message,
    status: row.status,
    existingTutorId: row.existingTutorId,
    convertedTutorId: row.convertedTutorId,
    note: row.note,
    purgedAt: row.purgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export interface LeadSubmission {
  slug: string
  input: SiteLeadInput & { phone: string }
  ipAddress: string
  userAgent: string | null
}

/**
 * O envio do formulário público.
 *
 * **O honeypot responde 201, idêntico ao sucesso** (RN-08). Responder com erro
 * ensinaria o bot a contornar: ele tentaria de novo sem o campo. A checagem acontece
 * antes de qualquer escrita e antes do rate limit — o bot não consome a cota de
 * ninguém.
 */
export async function submitLead(submission: LeadSubmission): Promise<void> {
  const tenant = await resolveTenant(submission.slug)
  const { input, ipAddress, userAgent } = submission

  if (input.website !== undefined && input.website !== '') {
    // Nem `security_events` nem erro: o registro é a métrica, e o que interessa não é
    // cada bot, é a curva deles ao longo do dia.
    recordMetric({ metric: 'site_lead_honeypot', tenantId: tenant.id, value: 1, unit: 'count' })
    return
  }

  if (!(await withinRateLimit(tenant.id, ipAddress))) {
    recordMetric({ metric: 'site_lead_throttled', tenantId: tenant.id, value: 1, unit: 'count' })
    throw tooManySubmissions()
  }

  const { leadId, isExistingCustomer } = await withTenant(tenant.id, async (tx) => {
    // O formulário não é porta de entrada para o site desligado: quem chegou aqui com
    // o site fora do ar montou a requisição à mão.
    const site = await tx.siteSettings.findUnique({
      where: { tenantId: tenant.id },
      select: { published: true, leadFormEnabled: true },
    })
    if (!site?.published || !site.leadFormEnabled) throw leadNotFound('Formulário indisponível')

    const cipher = await openCipher(tx, tenant.id)
    const phoneHash = hashSearchable(TUTOR_PHONE_HASH_NAMESPACE, input.phone)

    // AC-04: o telefone casa com um tutor do tenant. A equipe precisa saber que não é
    // aquisição — é um cliente que não achou o WhatsApp. **Nada disso volta ao
    // visitante**: a resposta é a mesma nos dois casos.
    const existing = await tx.tutor.findFirst({
      where: { phoneHash, deletedAt: null },
      select: { id: true },
    })

    const lead = await tx.siteLead.create({
      data: {
        tenantId: tenant.id,
        name: input.name,
        phoneEncrypted: cipher.encrypt(input.phone),
        phoneHash,
        emailEncrypted: input.email ? cipher.encrypt(input.email) : null,
        message: input.message ?? null,
        existingTutorId: existing?.id ?? null,
        ipAddress,
        userAgent,
      },
      select: { id: true },
    })

    await recordAudit(tx, {
      tenantId: tenant.id,
      actorUserId: null,
      action: 'site_lead.received',
      entity: 'site_lead',
      entityId: lead.id,
      after: { isExistingCustomer: existing !== null },
      ipAddress,
      userAgent,
    })

    return { leadId: lead.id, isExistingCustomer: existing !== null }
  })

  await publishEvent(SITE_ROUTING_KEYS.leadRecebido, {
    tenantId: tenant.id,
    slug: tenant.slug,
    leadId,
    isExistingCustomer,
  })

  recordMetric({ metric: 'site_lead_received', tenantId: tenant.id, value: 1, unit: 'count' })
  logger.info({ tenantId: tenant.id, leadId, isExistingCustomer }, 'lead recebido')
}

export interface LeadListResult {
  items: SiteLead[]
  total: number
  newCount: number
}

/**
 * Quantos contatos esperam retorno — e nada mais.
 *
 * O sino da topbar chama isto em toda tela do Admin, então a consulta é um `COUNT` e
 * **não abre a cifra de ninguém**: nenhum telefone ou e-mail sai do banco para
 * alimentar um número. `listLeads` continua sendo o caminho de quem vai *ver* a fila.
 */
export async function countNewLeads(actor: ActorContext): Promise<number> {
  return withTenant(actor.tenantId, (tx) => tx.siteLead.count({ where: { status: 'NEW' } }))
}

export async function listLeads(
  actor: ActorContext,
  filter: { status?: SiteLeadStatus },
): Promise<LeadListResult> {
  return withTenant(actor.tenantId, async (tx) => {
    const where = filter.status ? { status: filter.status } : {}

    const [rows, total, newCount] = await Promise.all([
      tx.siteLead.findMany({
        where,
        // `NEW` no topo (AC-01): a fila é de trabalho, não de histórico.
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        select: LEAD_SELECT,
      }),
      tx.siteLead.count({ where }),
      tx.siteLead.count({ where: { status: 'NEW' } }),
    ])

    const cipher = await openCipher(tx, actor.tenantId)
    return {
      items: rows.map((row) => toDto(row, (payload) => decryptOptional(cipher, payload))),
      total,
      newCount,
    }
  })
}

export async function updateLead(
  actor: ActorContext,
  leadId: string,
  input: { status?: Exclude<SiteLeadStatus, 'CONVERTED'>; note?: string | null | undefined },
): Promise<SiteLead> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.siteLead.findUnique({ where: { id: leadId }, select: LEAD_SELECT })
      if (!before) throw leadNotFound()

      // Convertido é terminal: o lead virou tutor, e "desconverter" deixaria a ficha
      // criada sem origem. Descartar um convertido também não faz sentido.
      if (before.status === 'CONVERTED' && input.status) {
        throw invalidLeadTransition('Este contato já virou cliente')
      }

      const row = await tx.siteLead.update({
        where: { id: leadId },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.note !== undefined ? { note: input.note ?? null } : {}),
        },
        select: LEAD_SELECT,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.status === 'DISCARDED' ? 'site_lead.discarded' : 'site_lead.updated',
        entity: 'site_lead',
        entityId: leadId,
        before: { status: before.status },
        after: { status: row.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const cipher = await openCipher(tx, actor.tenantId)
      return toDto(row, (payload) => decryptOptional(cipher, payload))
    },
    tenantOptions(actor),
  )
}

/**
 * Marca o lead como convertido, apontando para o tutor que a recepção criou.
 *
 * **Quem cria o tutor é o MOD-TUTOR**, pela tela de sempre, com a detecção de
 * duplicata que ela já tem (AC-03). Este serviço não cria ficha de cliente: fazê-lo
 * duplicaria as regras de CPF, consentimento e dedupe num lugar onde ninguém iria
 * procurá-las.
 */
export async function convertLead(
  actor: ActorContext,
  leadId: string,
  tutorId: string,
): Promise<SiteLead> {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.siteLead.findUnique({ where: { id: leadId }, select: LEAD_SELECT })
      if (!before) throw leadNotFound()
      if (before.status === 'CONVERTED') {
        throw invalidLeadTransition('Este contato já virou cliente')
      }

      const tutor = await tx.tutor.findFirst({
        where: { id: tutorId, deletedAt: null },
        select: { id: true },
      })
      if (!tutor) throw leadNotFound('Tutor não encontrado')

      const row = await tx.siteLead.update({
        where: { id: leadId },
        data: { status: 'CONVERTED', convertedTutorId: tutorId },
        select: LEAD_SELECT,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'site_lead.converted',
        entity: 'site_lead',
        entityId: leadId,
        before: { status: before.status },
        after: { status: 'CONVERTED', tutorId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const cipher = await openCipher(tx, actor.tenantId)
      return toDto(row, (payload) => decryptOptional(cipher, payload))
    },
    tenantOptions(actor),
  )

  const tenant = await withTenant(actor.tenantId, (tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { slug: true } }),
  )

  await publishEvent(SITE_ROUTING_KEYS.leadConvertido, {
    tenantId: actor.tenantId,
    slug: tenant.slug,
    leadId,
    tutorId,
    actorId: actor.actorUserId ?? null,
  })

  recordMetric({ metric: 'site_lead_converted', tenantId: actor.tenantId, value: 1, unit: 'count' })
  return result
}
