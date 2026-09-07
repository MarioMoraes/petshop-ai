import { randomUUID } from 'node:crypto'
import {
  Prisma,
  createTenantKey,
  decryptForTenant,
  encryptForTenant,
  filterTakenSlugs,
  getPrisma,
  isSlugTaken,
  withTenant,
  type Tenant,
  type TenantTransaction,
} from '@petshop/db'
import {
  AppError,
  DEFAULT_BRANDING,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_TERM_VERSION,
  IDENTITY_ROUTING_KEYS,
  ONBOARDING_LAST_STEP,
  PLATFORM_TERM_SEEDS,
  SEED_SERVICES,
  isReservedSlug,
  isValidSlug,
  slugSuggestions,
  TERM_KINDS,
  type CreateTenantInput,
  type SlugAvailability,
  type TenantResponse,
} from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { recordAudit } from '../../lib/audit.js'
import { getClerk } from '../../lib/clerk.js'
import { conflict, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { logger, recordMetric } from '../../lib/logger.js'
import { ensureLocalUser } from '../users/service.js'

/**
 * MOD-IDENT-01 — Provisionamento de Tenant.
 *
 * A ordem das operações é o ponto central deste módulo. O tenant é criado
 * **localmente e comitado** antes de qualquer chamada ao Clerk. Isso é deliberado:
 * o Clerk é um sistema externo que pode dar timeout, e uma transação distribuída
 * entre banco e HTTP não existe. Comitando primeiro em `PROVISIONING`, uma falha do
 * Clerk deixa um registro recuperável, que o job de retry retoma de forma idempotente
 * (AC-03) — em vez de um tenant perdido ou uma Organization órfã.
 */

export interface ProvisionTenantParams {
  input: CreateTenantInput
  clerkUserId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export async function provisionTenant(params: ProvisionTenantParams): Promise<TenantResponse> {
  const startedAt = Date.now()
  const { input, clerkUserId } = params

  // AC-04 — slug reservado pela plataforma.
  if (isReservedSlug(input.slug)) {
    throw new AppError('ERR_IDENT_002', 'Este endereço é reservado pela plataforma', [
      { field: 'slug', message: 'Este endereço é reservado pela plataforma' },
    ])
  }

  const admin = await ensureLocalUser(clerkUserId)

  const tenantId = randomUUID()
  const provisioningKey = randomUUID()

  // O UUID é gerado aqui, e não pelo banco, porque a política RLS de `tenants` compara
  // `id = current_tenant_id()`: sem conhecer o id de antemão, o WITH CHECK do INSERT
  // não teria como passar.
  await createTenantRow({ tenantId, provisioningKey, input, adminUserId: admin.id, params })

  const tenant = await finalizeProvisioning(tenantId)
  recordMetric({
    metric: 'tenant_provisioning_duration',
    tenantId,
    value: Date.now() - startedAt,
    unit: 'milliseconds',
  })

  return toTenantResponse(tenant.row, tenant.cnpj)
}

async function createTenantRow(args: {
  tenantId: string
  provisioningKey: string
  input: CreateTenantInput
  adminUserId: string
  params: ProvisionTenantParams
}): Promise<void> {
  const { tenantId, provisioningKey, input, adminUserId, params } = args

  try {
    await withTenant(
      tenantId,
      async (tx) => {
        await tx.tenant.create({
          data: {
            id: tenantId,
            slug: input.slug,
            name: input.name,
            legalName: input.legalName ?? null,
            plan: input.plan,
            status: 'PROVISIONING',
            provisioningKey,
          },
        })

        // A DEK precisa existir antes de cifrar o primeiro campo do tenant.
        await createTenantKey(tx, tenantId)
        if (input.cnpj) {
          await tx.tenant.update({
            where: { id: tenantId },
            data: { cnpjEncrypted: await encryptForTenant(tx, tenantId, input.cnpj) },
          })
        }

        await tx.tenantSettings.create({
          data: {
            tenantId,
            timezone: input.timezone,
            branding: DEFAULT_BRANDING,
            businessHours: DEFAULT_BUSINESS_HOURS,
          },
        })

        await tx.membership.create({
          data: {
            tenantId,
            userId: adminUserId,
            roleKey: 'TENANT_ADMIN',
            status: 'ACTIVE',
          },
        })

        await seedTenantDomain(tx, tenantId)

        await recordAudit(tx, {
          tenantId,
          actorUserId: adminUserId,
          action: 'tenant.created',
          entity: 'tenant',
          entityId: tenantId,
          after: { slug: input.slug, name: input.name, plan: input.plan },
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        })
      },
      { userId: adminUserId },
    )
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // RN-08: o índice único é a autoridade sobre unicidade de slug. Nunca um SELECT
      // antes do INSERT — entre a leitura e a escrita cabe outra requisição.
      throw await slugConflict(input.slug)
    }
    throw error
  }
}

async function slugConflict(slug: string): Promise<AppError> {
  const suggestions = await availableSuggestions(slug)
  const detail = suggestions.length
    ? `Este endereço já está em uso. Sugestões: ${suggestions.join(', ')}`
    : 'Este endereço já está em uso.'
  return conflict(detail, [
    { field: 'slug', message: 'Já existe um estabelecimento com este endereço' },
  ])
}

async function availableSuggestions(slug: string, limit = 2): Promise<string[]> {
  const candidates = slugSuggestions(slug, limit + 6)
  const taken = await filterTakenSlugs(candidates)
  return candidates.filter((candidate) => !taken.has(candidate)).slice(0, limit)
}

/**
 * Etapa externa do provisionamento, idempotente por construção: chamada tanto pelo
 * `POST /v1/tenants` quanto pelo job de retry.
 *
 * A idempotência vem do slug — que é o mesmo no tenant local e na Organization do
 * Clerk. Se a criação anterior chegou a acontecer e só a resposta se perdeu, a busca
 * por slug reencontra a Organization em vez de criar uma segunda.
 */
export async function finalizeProvisioning(
  tenantId: string,
): Promise<{ row: Tenant; cnpj: string | null }> {
  const env = loadEnv()

  const current = await withTenant(tenantId, async (tx) => {
    const row = await tx.tenant.findUnique({ where: { id: tenantId } })
    if (!row) throw notFound('Estabelecimento não encontrado')
    const membership = await tx.membership.findFirst({
      where: { tenantId, roleKey: 'TENANT_ADMIN', status: 'ACTIVE' },
      select: { userId: true, permVersion: true },
    })
    return { row, membership }
  })

  if (current.row.status !== 'PROVISIONING') {
    // Já finalizado por outra execução; nada a fazer.
    return { row: current.row, cnpj: await readCnpj(current.row) }
  }

  const adminUserId = current.membership?.userId
  if (!adminUserId) {
    throw new Error(`Tenant ${tenantId} sem membership de administrador`)
  }
  const adminClerkId = await getPrisma()
    .user.findUnique({ where: { id: adminUserId }, select: { clerkUserId: true } })
    .then((user) => user?.clerkUserId)
  if (!adminClerkId) {
    throw new Error(`Administrador ${adminUserId} sem clerk_user_id`)
  }

  try {
    const clerk = getClerk()
    const organization =
      (await clerk.findOrganizationBySlug(current.row.slug)) ??
      (await clerk.createOrganization({
        name: current.row.name,
        slug: current.row.slug,
        createdBy: adminClerkId,
        publicMetadata: { tenantId, provisioningKey: current.row.provisioningKey },
      }))

    // RN-03: o gateway compara este valor com o claim do token para detectar sessão
    // com papel desatualizado.
    await clerk.setMembershipPermVersion({
      organizationId: organization.id,
      clerkUserId: adminClerkId,
      permVersion: current.membership?.permVersion ?? 1,
    })

    const trialEndsAt = new Date(Date.now() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000)

    const updated = await withTenant(
      tenantId,
      async (tx) => {
        const row = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            clerkOrgId: organization.id,
            status: 'TRIAL',
            trialEndsAt,
            provisioningLastError: null,
          },
        })
        await recordAudit(tx, {
          tenantId,
          actorUserId: adminUserId,
          action: 'tenant.status_changed',
          entity: 'tenant',
          entityId: tenantId,
          before: { status: 'PROVISIONING' },
          after: { status: 'TRIAL', clerkOrgId: organization.id },
        })
        return row
      },
      { userId: adminUserId },
    )

    await publishEvent(IDENTITY_ROUTING_KEYS.tenantCriado, {
      tenantId,
      slug: updated.slug,
      plan: updated.plan,
      adminUserId,
    })
    await publishEvent(IDENTITY_ROUTING_KEYS.membershipCriado, {
      tenantId,
      userId: adminUserId,
      roleKey: 'TENANT_ADMIN',
      isProfessional: false,
    })

    return { row: updated, cnpj: await readCnpj(updated) }
  } catch (error) {
    const row = await registerProvisioningFailure(tenantId, error, env.PROVISIONING_MAX_ATTEMPTS)
    return { row, cnpj: await readCnpj(row) }
  }
}

/**
 * AC-03 — contabiliza a falha e, na 5ª, encerra em `PROVISIONING_FAILED` com alerta
 * ao Super Admin. Até lá o tenant fica em `PROVISIONING`, que é o estado que o job
 * de retry procura.
 */
async function registerProvisioningFailure(
  tenantId: string,
  error: unknown,
  maxAttempts: number,
): Promise<Tenant> {
  const message = error instanceof Error ? error.message : String(error)
  logger.error({ err: error, tenantId }, 'falha ao provisionar tenant no Clerk')

  return withTenant(tenantId, async (tx) => {
    const current = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { provisioningAttempts: true },
    })
    const attempts = current.provisioningAttempts + 1
    const exhausted = attempts >= maxAttempts

    const row = await tx.tenant.update({
      where: { id: tenantId },
      data: {
        provisioningAttempts: attempts,
        provisioningLastError: message.slice(0, 500),
        ...(exhausted ? { status: 'PROVISIONING_FAILED' as const } : {}),
      },
    })

    if (exhausted) {
      logger.error(
        { alert: 'PROVISIONING_FAILED', tenantId, attempts },
        'provisionamento esgotou as tentativas — intervenção do Super Admin necessária',
      )
      await recordAudit(tx, {
        tenantId,
        action: 'tenant.status_changed',
        entity: 'tenant',
        entityId: tenantId,
        before: { status: 'PROVISIONING' },
        after: { status: 'PROVISIONING_FAILED', attempts, error: message.slice(0, 200) },
      })
    }

    return row
  })
}

/**
 * Cadastros de domínio que o AC-01 manda semear.
 *
 * Espécies, portes e pelagens **não** entram aqui: o MOD-PET decidiu que o catálogo
 * é global (`tenant_id IS NULL`, seed único da plataforma), e copiá-lo por tenant
 * multiplicaria por mil linhas que ninguém edita. O que é por tenant são os
 * serviços-modelo — daí este seed cuidar só deles.
 *
 * Roda dentro da transação do provisionamento, de propósito: um tenant que existe
 * com catálogo pela metade é pior que um provisionamento que falhou e será
 * retentado (AC-03).
 */
async function seedTenantDomain(tx: TenantTransaction, tenantId: string): Promise<void> {
  await seedPlatformTerms(tx, tenantId)

  // Os portes são catálogo global; o seed dos serviços os referencia por chave, e o
  // UUID só é resolvido aqui.
  const sizes = await tx.size.findMany({
    where: { tenantId: null },
    select: { id: true, key: true },
  })
  const sizeIdByKey = new Map(sizes.map((size) => [size.key, size.id]))

  // Sem catálogo de portes não há preço a semear. Acontece em banco recém-criado
  // antes do seed de plataforma, e não é motivo para derrubar o provisionamento: o
  // petshop cadastra os serviços à mão e nada mais quebra.
  if (sizeIdByKey.size === 0) return

  for (const seed of SEED_SERVICES) {
    await tx.service.create({
      data: {
        tenantId,
        name: seed.name,
        category: seed.category,
        description: seed.description,
        baseDurationMin: seed.baseDurationMin,
        requiresVet: seed.requiresVet,
        pricing: {
          create: seed.pricing.flatMap((item) => {
            const sizeId = sizeIdByKey.get(item.sizeKey)
            return sizeId
              ? [
                  {
                    tenantId,
                    sizeId,
                    priceCents: BigInt(item.priceCents),
                    durationMin: item.durationMin,
                  },
                ]
              : []
          }),
        },
      },
    })
  }
}

/**
 * As três versões `1.0` dos termos da plataforma (AC-02 de MOD-DOC-06).
 *
 * Roda dentro da transação do provisionamento porque um estabelecimento sem termo
 * nenhum não consegue cadastrar o primeiro tutor: desde o MOD-DOC-06 toda linha de
 * `tutor_consents` tem a versão conferida contra `term_versions`, e prova de aceite sem
 * documento aceito é justamente o defeito que aquele módulo veio corrigir.
 *
 * `1.0` é o mesmo número que o parque anterior já gravava, e é por isso que ele vale
 * retroativamente. **Mudar o texto de `PLATFORM_TERM_SEEDS` exige subir o número do
 * seed**: o que já foi semeado é texto publicado, e publicado não se reescreve — dois
 * tenants com `1.0` diferentes é a mesma falsificação, distribuída no tempo.
 *
 * `published_by` fica nulo de propósito: quem publicou foi a plataforma, não uma pessoa.
 */
async function seedPlatformTerms(tx: TenantTransaction, tenantId: string): Promise<void> {
  await tx.termVersion.createMany({
    data: TERM_KINDS.map((kind) => ({
      tenantId,
      kind,
      version: DEFAULT_TERM_VERSION,
      title: PLATFORM_TERM_SEEDS[kind].title,
      body: PLATFORM_TERM_SEEDS[kind].body,
    })),
    skipDuplicates: true,
  })
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export async function getTenant(tenantId: string): Promise<TenantResponse> {
  const row = await withTenant(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId } }))
  if (!row) throw notFound('Estabelecimento não encontrado')
  return toTenantResponse(row, await readCnpj(row))
}

export interface UpdateTenantParams {
  tenantId: string
  actorUserId?: string | undefined
  data: { name?: string; legalName?: string | null; cnpj?: string | null }
}

export async function updateTenant(params: UpdateTenantParams): Promise<TenantResponse> {
  const { tenantId, data } = params

  const row = await withTenant(
    tenantId,
    async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: tenantId } })
      if (!before) throw notFound('Estabelecimento não encontrado')

      const patch: Prisma.TenantUpdateInput = {}
      if (data.name !== undefined) patch.name = data.name
      if (data.legalName !== undefined) patch.legalName = data.legalName
      if (data.cnpj !== undefined) {
        patch.cnpjEncrypted = data.cnpj ? await encryptForTenant(tx, tenantId, data.cnpj) : null
      }

      const updated = await tx.tenant.update({ where: { id: tenantId }, data: patch })
      await recordAudit(tx, {
        tenantId,
        actorUserId: params.actorUserId ?? null,
        action: 'tenant.updated',
        entity: 'tenant',
        entityId: tenantId,
        before: { name: before.name, legalName: before.legalName },
        after: { name: updated.name, legalName: updated.legalName },
      })
      return updated
    },
    params.actorUserId ? { userId: params.actorUserId } : {},
  )

  return toTenantResponse(row, await readCnpj(row))
}

/** Disponibilidade de slug para o feedback ao vivo da etapa 1 do wizard. */
export async function checkSlugAvailability(slug: string): Promise<SlugAvailability> {
  const normalized = slug.trim().toLowerCase()

  if (!isValidSlug(normalized)) {
    return {
      slug: normalized,
      available: false,
      reason: 'INVALID',
      suggestions: await availableSuggestions(normalized, 3),
    }
  }
  if (isReservedSlug(normalized)) {
    return {
      slug: normalized,
      available: false,
      reason: 'RESERVED',
      suggestions: await availableSuggestions(normalized, 3),
    }
  }
  if (await isSlugTaken(normalized)) {
    return {
      slug: normalized,
      available: false,
      reason: 'TAKEN',
      suggestions: await availableSuggestions(normalized, 3),
    }
  }
  return { slug: normalized, available: true, reason: 'AVAILABLE', suggestions: [] }
}

async function readCnpj(row: Tenant): Promise<string | null> {
  if (!row.cnpjEncrypted) return null
  return withTenant(row.id, (tx) => decryptForTenant(tx, row.id, row.cnpjEncrypted as string))
}

/**
 * Prende a etapa ao último passo vigente.
 *
 * O wizard já teve cinco etapas; a de convite de equipe saiu quando ficou claro que
 * ela não coletava nada enquanto MOD-IDENT-06 não existir. Tenants gravados naquele
 * momento têm `onboarding_step = 5`, valor que o contrato não admite mais. Prender na
 * leitura evita uma migration para corrigir um número que só diz "acabou".
 */
export function clampOnboardingStep(step: number): number {
  return Math.min(Math.max(step, 1), ONBOARDING_LAST_STEP)
}

export function toTenantResponse(row: Tenant, cnpj: string | null): TenantResponse {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legalName,
    cnpj,
    status: row.status,
    plan: row.plan,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    onboardingStep: clampOnboardingStep(row.onboardingStep),
    onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
