import { withTenant, type TenantTransaction } from '@petshop/db'
import type {
  CreateProfessionalInput,
  ScheduleWindow,
  UpdateProfessionalInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { futureAppointmentsBlock, invalid, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { invalidateCatalog } from '../../lib/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { toProfessionalResponse } from './mapper.js'
import { appointments } from './port.js'

/** MOD-AGENDA-02 — profissionais e jornada. */

const PROFESSIONAL_INCLUDE = { services: true, schedules: true } as const

async function assertServicesExist(tx: TenantTransaction, serviceIds: string[]) {
  if (serviceIds.length === 0) return
  const found = await tx.service.findMany({
    where: { id: { in: serviceIds }, deletedAt: null },
    select: { id: true },
  })
  if (found.length !== new Set(serviceIds).size) {
    throw notFound('Um dos serviços informados não existe')
  }
}

export async function createProfessional(actor: ActorContext, input: CreateProfessionalInput) {
  const created = await withTenant(
    actor.tenantId,
    async (tx) => {
      await assertServicesExist(tx, input.serviceIds)

      const professional = await tx.professional.create({
        data: {
          tenantId: actor.tenantId,
          userId: input.userId ?? null,
          displayName: input.displayName,
          roleKey: input.roleKey,
          maxConcurrentPets: input.maxConcurrentPets,
          color: input.color ?? null,
          createdBy: actor.actorUserId ?? null,
          services: {
            create: input.serviceIds.map((serviceId) => ({
              tenantId: actor.tenantId,
              serviceId,
            })),
          },
        },
        include: PROFESSIONAL_INCLUDE,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'professional.created',
        entity: 'professional',
        entityId: professional.id,
        after: {
          displayName: professional.displayName,
          roleKey: professional.roleKey,
          maxConcurrentPets: professional.maxConcurrentPets,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return professional
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, [created.id])
  await publishEvent('agenda.profissional.alterado', {
    tenantId: actor.tenantId,
    professionalId: created.id,
    action: 'CREATED',
  })

  return toProfessionalResponse(created)
}

export async function listProfessionals(actor: ActorContext, includeInactive = false) {
  const rows = await withTenant(actor.tenantId, (tx) =>
    tx.professional.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { active: true }) },
      include: PROFESSIONAL_INCLUDE,
      orderBy: { displayName: 'asc' },
    }),
  )
  return rows.map(toProfessionalResponse)
}

/**
 * AC-04: desligar quem tem agendamento futuro devolve 409 com a lista e a oferta de
 * reatribuição em lote. Sem reatribuir, a desativação não conclui — deixar alguém
 * inativo com agenda cheia é a receita para o pet aparecer e não ter quem o atenda.
 */
export async function updateProfessional(
  actor: ActorContext,
  professionalId: string,
  input: UpdateProfessionalInput,
) {
  const updated = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await tx.professional.findFirst({
        where: { id: professionalId, deletedAt: null },
        include: PROFESSIONAL_INCLUDE,
      })
      if (!before) throw notFound('Profissional não encontrado')

      if (input.active === false && before.active) {
        const future = await appointments().listByProfessional(tx, professionalId)
        if (future.length > 0) {
          throw futureAppointmentsBlock(
            `${before.displayName} tem ${future.length} agendamento(s) futuro(s). Reatribua-os a outro profissional antes de desativar.`,
            {
              professionalId,
              appointments: future.map((item) => ({
                id: item.id,
                startsAt: item.startsAt.toISOString(),
                petName: item.petName,
              })),
            },
          )
        }
      }

      if (input.serviceIds) {
        await assertServicesExist(tx, input.serviceIds)
        await tx.professionalService.deleteMany({ where: { professionalId } })
        await tx.professionalService.createMany({
          data: input.serviceIds.map((serviceId) => ({
            tenantId: actor.tenantId,
            professionalId,
            serviceId,
          })),
        })
      }

      const professional = await tx.professional.update({
        where: { id: professionalId },
        data: {
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.roleKey === undefined ? {} : { roleKey: input.roleKey }),
          ...(input.maxConcurrentPets === undefined
            ? {}
            : { maxConcurrentPets: input.maxConcurrentPets }),
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
        include: PROFESSIONAL_INCLUDE,
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: input.active === false ? 'professional.deactivated' : 'professional.updated',
        entity: 'professional',
        entityId: professionalId,
        before: {
          displayName: before.displayName,
          active: before.active,
          maxConcurrentPets: before.maxConcurrentPets,
        },
        after: {
          displayName: professional.displayName,
          active: professional.active,
          maxConcurrentPets: professional.maxConcurrentPets,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return professional
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, [professionalId])
  await publishEvent('agenda.profissional.alterado', {
    tenantId: actor.tenantId,
    professionalId,
    action: input.active === false ? 'DEACTIVATED' : 'UPDATED',
  })

  return toProfessionalResponse(updated)
}

/**
 * Jornada semanal, substituída inteira.
 *
 * AC-03: jornada além do horário do tenant é **aceita**, e o serviço devolve
 * `warnings[]`. O veterinário que atende emergência depois do fechamento existe, e a
 * agenda não pode negar a realidade da operação — avisar é útil, bloquear é mentir.
 */
export async function replaceSchedule(
  actor: ActorContext,
  professionalId: string,
  windows: ScheduleWindow[],
) {
  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      const professional = await tx.professional.findFirst({
        where: { id: professionalId, deletedAt: null },
      })
      if (!professional) throw notFound('Profissional não encontrado')

      assertNoOverlap(windows)

      await tx.professionalSchedule.deleteMany({ where: { professionalId } })
      await tx.professionalSchedule.createMany({
        data: windows.map((window) => ({
          tenantId: actor.tenantId,
          professionalId,
          weekday: window.weekday,
          startsAtMin: window.startsAtMin,
          endsAtMin: window.endsAtMin,
        })),
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'professional.schedule_updated',
        entity: 'professional',
        entityId: professionalId,
        after: { windows },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      const settings = await tx.tenantSettings.findFirst({
        where: { tenantId: actor.tenantId },
        select: { businessHours: true },
      })

      const updated = await tx.professional.findFirstOrThrow({
        where: { id: professionalId },
        include: PROFESSIONAL_INCLUDE,
      })

      return {
        professional: updated,
        warnings: warnOutsideBusinessHours(windows, settings?.businessHours),
      }
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, [professionalId])
  await publishEvent('agenda.profissional.alterado', {
    tenantId: actor.tenantId,
    professionalId,
    action: 'SCHEDULE_CHANGED',
  })

  return {
    ...toProfessionalResponse(result.professional),
    warnings: result.warnings,
  }
}

/**
 * Duas faixas do mesmo dia não podem se sobrepor.
 *
 * Não é preciosismo: o cálculo de disponibilidade soma as faixas do dia, e faixas
 * sobrepostas ofereceriam o mesmo horário duas vezes. O Zod valida cada faixa
 * isolada; a relação entre elas só dá para conferir com a lista na mão.
 */
function assertNoOverlap(windows: ScheduleWindow[]): void {
  const byDay = new Map<number, ScheduleWindow[]>()
  for (const window of windows) {
    byDay.set(window.weekday, [...(byDay.get(window.weekday) ?? []), window])
  }

  for (const [weekday, dayWindows] of byDay) {
    const sorted = [...dayWindows].sort((a, b) => a.startsAtMin - b.startsAtMin)
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]
      const current = sorted[i]
      if (previous && current && current.startsAtMin < previous.endsAtMin) {
        throw invalid('Há faixas de horário sobrepostas no mesmo dia', [
          { field: `windows.${weekday}`, message: 'Faixas do mesmo dia não podem se sobrepor' },
        ])
      }
    }
  }
}

const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** AC-03: avisa, não bloqueia. */
function warnOutsideBusinessHours(windows: ScheduleWindow[], businessHours: unknown): string[] {
  if (!businessHours || typeof businessHours !== 'object') return []
  const hours = businessHours as Record<string, { open?: string; close?: string } | undefined>

  const warnings: string[] = []
  for (const window of windows) {
    const day = hours[WEEKDAY_KEYS[window.weekday] ?? '']
    if (!day?.open || !day.close) continue

    const open = toMinutes(day.open)
    const close = toMinutes(day.close)
    if (open === null || close === null) continue

    if (window.startsAtMin < open || window.endsAtMin > close) {
      warnings.push(
        `A jornada de ${WEEKDAY_LABELS[window.weekday] ?? 'um dos dias'} vai além do horário de funcionamento (${day.open}–${day.close}).`,
      )
    }
  }
  return warnings
}

const WEEKDAY_LABELS = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
]

function toMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}
