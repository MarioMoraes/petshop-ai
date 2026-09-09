import { withTenant, type TenantTransaction } from '@petshop/db'
import type {
  CreateServiceInput,
  ServicePricingItem,
  UpdateServiceInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { invalid, notFound, serviceInUse } from '../scheduling/errors.js'
import { publishEvent } from '../../shared/events.js'
import { invalidateScheduleCatalog } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { toServiceResponse } from './mapper.js'
import { appointments } from './port.js'

/**
 * MOD-AGENDA-01/02/03 — o catálogo que a agenda precisa antes de existir: o que se
 * vende, quem executa e quando não dá.
 *
 * Uma escolha atravessa o arquivo inteiro: **nada aqui consulta `appointments`**.
 * A tabela ainda não existe (fatia 2), e as regras que dependem dela — AC-03 do
 * serviço em uso, AC-04 do desligamento, AC-02 do bloqueio sobre agendamento — estão
 * escritas e testadas atrás de `countFutureAppointments`, uma porta injetável. É o
 * mesmo padrão que o pet-service usou para o AC-02 da transferência: a regra existe,
 * está no caminho e tem teste; falta só quem responda. Quando a fatia 2 chegar é
 * `setAppointmentsPort` no `app.ts` e nada mais muda aqui.
 */

// ─── MOD-AGENDA-01 — serviços ────────────────────────────────────────────────

/**
 * Confere que todo porte citado existe e é visível para este tenant.
 *
 * Os portes são catálogo global (MOD-PET-03), então um id inventado passaria pela FK
 * de outro tenant sem RLS reclamar — a checagem é aqui.
 */
async function assertSizesExist(tx: TenantTransaction, pricing: ServicePricingItem[]) {
  if (pricing.length === 0) return

  const sizeIds = [...new Set(pricing.map((item) => item.sizeId))]
  if (sizeIds.length !== pricing.length) {
    throw invalid('Há mais de um preço para o mesmo porte')
  }

  const found = await tx.size.findMany({ where: { id: { in: sizeIds } }, select: { id: true } })
  if (found.length !== sizeIds.length) {
    throw invalid('Um dos portes informados não existe no catálogo')
  }
}

async function assertProfessionalsExist(tx: TenantTransaction, professionalIds: string[]) {
  if (professionalIds.length === 0) return

  const found = await tx.professional.findMany({
    where: { id: { in: professionalIds }, deletedAt: null },
    select: { id: true },
  })
  if (found.length !== new Set(professionalIds).size) {
    throw notFound('Um dos profissionais informados não existe')
  }
}

const SERVICE_INCLUDE = { pricing: true, professionals: true } as const

export async function createService(actor: ActorContext, input: CreateServiceInput) {
  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertSizesExist(tx, input.pricing)
      await assertProfessionalsExist(tx, input.professionalIds)

      const service = await tx.service.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          category: input.category,
          description: input.description ?? null,
          baseDurationMin: input.baseDurationMin,
          requiresVet: input.requiresVet,
          createdBy: actor.actorUserId ?? null,
          pricing: {
            create: input.pricing.map((item) => ({
              tenantId: actor.tenantId,
              sizeId: item.sizeId,
              priceCents: BigInt(item.priceCents),
              durationMin: item.durationMin,
            })),
          },
          professionals: {
            create: input.professionalIds.map((professionalId) => ({
              tenantId: actor.tenantId,
              professionalId,
            })),
          },
        },
        include: SERVICE_INCLUDE,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'service.created',
        entity: 'service',
        entityId: service.id,
        after: { name: service.name, category: service.category, pricing: input.pricing },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return service
    },
    tenantOptions(actor),
  )

  await invalidateScheduleCatalog(
    actor.tenantId,
    created.professionals.map((link) => link.professionalId),
  )
  await publishEvent('agenda.servico.alterado', {
    tenantId: actor.tenantId,
    serviceId: created.id,
    action: 'CREATED',
  })

  return toServiceResponse(created)
}

export async function listServices(actor: ActorContext, includeInactive = false) {
  const rows = await withTenant(actor.tenantId, (tx) =>
    tx.service.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { active: true }) },
      include: SERVICE_INCLUDE,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    }),
  )
  return rows.map(toServiceResponse)
}

export async function updateService(
  actor: ActorContext,
  serviceId: string,
  input: UpdateServiceInput,
) {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.service.findFirst({
        where: { id: serviceId, deletedAt: null },
        include: SERVICE_INCLUDE,
      })
      if (!before) throw notFound('Serviço não encontrado')

      if (input.professionalIds) {
        await assertProfessionalsExist(tx, input.professionalIds)
        // Substituição total: a habilitação é uma lista, e remendá-la item a item
        // deixaria o cliente sem como remover o último.
        await tx.professionalService.deleteMany({ where: { serviceId } })
        await tx.professionalService.createMany({
          data: input.professionalIds.map((professionalId) => ({
            tenantId: actor.tenantId,
            professionalId,
            serviceId,
          })),
        })
      }

      const service = await tx.service.update({
        where: { id: serviceId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.baseDurationMin === undefined
            ? {}
            : { baseDurationMin: input.baseDurationMin }),
          ...(input.requiresVet === undefined ? {} : { requiresVet: input.requiresVet }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.showOnSite === undefined ? {} : { showOnSite: input.showOnSite }),
        },
        include: SERVICE_INCLUDE,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.active === false ? 'service.deactivated' : 'service.updated',
        entity: 'service',
        entityId: serviceId,
        before: { name: before.name, active: before.active, requiresVet: before.requiresVet },
        after: { name: service.name, active: service.active, requiresVet: service.requiresVet },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return service
    },
    tenantOptions(actor),
  )

  await invalidateScheduleCatalog(
    actor.tenantId,
    updated.professionals.map((link) => link.professionalId),
  )
  await publishEvent('agenda.servico.alterado', {
    tenantId: actor.tenantId,
    serviceId,
    action: input.active === false ? 'DEACTIVATED' : 'UPDATED',
  })

  return toServiceResponse(updated)
}

/**
 * AC-03: serviço com agendamento futuro **não** é excluído.
 *
 * A desativação continua permitida e é o caminho que a mensagem de erro indica: some
 * do seletor sem tocar em nada já marcado. Exclusão é soft delete — o histórico do
 * agendamento antigo precisa continuar sabendo o nome do que foi vendido.
 */
export async function deleteService(actor: ActorContext, serviceId: string) {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const service = await tx.service.findFirst({ where: { id: serviceId, deletedAt: null } })
      if (!service) throw notFound('Serviço não encontrado')

      const futureCount = await appointments().countByService(tx, serviceId)
      if (futureCount > 0) {
        throw serviceInUse(
          `Este serviço tem ${futureCount} agendamento(s) futuro(s). Desative-o para tirá-lo do seletor sem afetar o que já está marcado.`,
          { futureAppointments: futureCount, serviceId },
        )
      }

      await tx.service.update({
        where: { id: serviceId },
        data: { deletedAt: new Date(), active: false },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'service.deleted',
        entity: 'service',
        entityId: serviceId,
        before: { name: service.name },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await invalidateScheduleCatalog(actor.tenantId)
}

/** `PUT`: a tabela de preços é substituída inteira, não remendada. */
export async function replaceServicePricing(
  actor: ActorContext,
  serviceId: string,
  pricing: ServicePricingItem[],
) {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const service = await tx.service.findFirst({ where: { id: serviceId, deletedAt: null } })
      if (!service) throw notFound('Serviço não encontrado')

      await assertSizesExist(tx, pricing)
      await tx.servicePricing.deleteMany({ where: { serviceId } })
      await tx.servicePricing.createMany({
        data: pricing.map((item) => ({
          tenantId: actor.tenantId,
          serviceId,
          sizeId: item.sizeId,
          priceCents: BigInt(item.priceCents),
          durationMin: item.durationMin,
        })),
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'service.pricing_updated',
        entity: 'service',
        entityId: serviceId,
        after: { pricing },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return tx.service.findFirstOrThrow({ where: { id: serviceId }, include: SERVICE_INCLUDE })
    },
    tenantOptions(actor),
  )

  await invalidateScheduleCatalog(actor.tenantId)
  await publishEvent('agenda.servico.alterado', {
    tenantId: actor.tenantId,
    serviceId,
    action: 'PRICING_CHANGED',
  })

  return toServiceResponse(updated)
}

/**
 * AC-02: preço ausente para o porte é **422**, nunca interpolação.
 *
 * Exportada porque é a fatia 2 que vai chamá-la ao montar o agendamento, e a regra
 * tem de ser a mesma que a tela de catálogo usa para avisar que falta preencher um
 * porte. Preço inventado no fechamento vira briga no balcão.
 */
export async function resolvePricing(actor: ActorContext, serviceId: string, sizeId: string) {
  return withTenant(actor.tenantId, async (tx) => {
    const service = await tx.service.findFirst({
      where: { id: serviceId, deletedAt: null },
      select: { id: true, name: true, active: true },
    })
    if (!service) throw notFound('Serviço não encontrado')
    if (!service.active) throw invalid(`O serviço "${service.name}" está desativado`)

    const size = await tx.size.findFirst({ where: { id: sizeId }, select: { label: true } })
    const pricing = await tx.servicePricing.findFirst({ where: { serviceId, sizeId } })

    if (!pricing) {
      throw invalid(
        `Este serviço não tem preço definido para o porte ${size?.label ?? 'informado'}`,
        [{ field: 'sizeId', message: 'Porte sem preço cadastrado neste serviço' }],
      )
    }

    return {
      serviceId,
      sizeId,
      priceCents: Number(pricing.priceCents),
      durationMin: pricing.durationMin,
    }
  })
}
